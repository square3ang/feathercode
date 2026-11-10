// feathercode — an OpenCode-style harness for Claude Code.
// Portions ported from OpenCode (https://github.com/anomalyco/opencode, branch dev),
// Copyright (c) 2025 opencode, MIT License. See ../NOTICE.md.
//
// Every hook and every `$` call lives in this file (the engine follows `$`
// only into functions declared here); ./lib holds the pure logic.
import type { EngineInterface, Register, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'

import {
  NUDGE,
  SUMMARY_ROOM,
  UNKNOWN_WINDOW,
  applyPrune,
  buildPrompt,
  checkpoint,
  estimate,
  flattenHistory,
  hasTemplate,
  isCheckpoint,
  messageTokens,
  planPrune,
  splitConversation,
  type Msg,
} from './lib/compaction'
import { resolveConfig, type Config, type Feature } from './lib/config'
import { attachLog, createLog, takeFlush, writeLog, type JsonlLog } from './lib/log'
import { isInside, planDir, type Mode } from './lib/modes'
import {
  DROPPED_ATTACHMENTS,
  EXPLORE_DESCRIPTION,
  EXPLORE_PROMPT,
  GENERAL_DESCRIPTION,
  PLAN_LEAVE,
  TOOL_DESCRIPTIONS,
  compactSkillListing,
  planDenied,
  planEnter,
  stripGitStatus,
  systemPrompt,
} from './lib/prompts'
import { Stats, formatStats, status } from './lib/stats'
import { deferralFor } from './lib/tools'

const PANE = 'feathercode-stats'
/** /compact instructions that ask for a prune (headless sessions queue one). */
const PRUNE_MARK = '__feathercode_prune__'
/** Built-in agent types the feathercode ones replace. */
const REPLACED_AGENTS = new Set(['Explore', 'general-purpose', 'Plan', 'claude'])

type Ctx = {
  cfg: Config
  log: JsonlLog
  stats: Stats
  /** The session's project root; the plan directory lives under it. */
  root: string
  sessionId: string
  mode: Mode
  agentsReady: boolean
  pendingPrune: boolean
  compacting: boolean
  /** The context window the session last reported (0: not yet). */
  window: number
  /** Context use the session last reported, in percent. */
  percent?: number
}

export const register: Register = (on, options) => {
  const o = options as Record<string, unknown>
  const ctx: Ctx = {
    cfg: resolveConfig(o),
    log: createLog(),
    stats: new Stats(),
    root: '.',
    sessionId: '',
    mode: 'build',
    agentsReady: false,
    pendingPrune: false,
    compacting: false,
    window: 0,
  }
  const has = (f: Feature) => ctx.cfg.features.has(f)

  // ---- session ---------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await loadCtx($, ctx)
    await $.command.register({ name: 'feathercode-stats', description: 'Token and prompt-cache usage of this session' })
    await $.command.register({ name: 'feathercode-panel', description: 'Show token and prompt-cache usage in a pane' })
    if (has('modes')) {
      // /plan is Claude Code's own command, so the agents register as fc-*.
      await $.command.register({ name: 'fc-plan', description: 'Plan agent: read-only, edits only in the plan directory (OpenCode plan)' })
      await $.command.register({ name: 'fc-build', description: 'Build agent: the default, full tool access (OpenCode build)' })
      await restoreMode($, ctx)
    }
    if (has('agents')) await registerAgents($, ctx)
    if (ctx.cfg.panel && (await $.session.surfaces()).length > 0) void $.ui.open({ id: PANE, title: 'feathercode' })
    showStatus($, ctx)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    writeLog(ctx.log, { t: Date.now(), ev: 'end', reason: e.reason, ...ctx.stats.totals(), sysChanges: ctx.stats.sysChanges })
    await flush($, ctx)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      writeLog(ctx.log, { t: Date.now(), ev: 'measure', tokens: e.context.tokens, window: e.context.window, percent: e.context.percent })
      ctx.window = e.context.window
      ctx.percent = e.context.percent
      showStatus($, ctx)
      // Compaction itself is Claude Code's trigger; only the opt-in prune is requested here.
      if (has('compact') && ctx.pendingPrune) await requestPrune($, ctx)
    }
    return next(e)
  })

  // ---- system prompt (phase 1) -----------------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!('sections' in r) || !r.sections) return r
    let out = r
    if (has('prompt') && e.outputStyle === null && !e.traits.includes('bare')) {
      const others = r.sections.filter(s => s.id.includes(':') && !s.id.startsWith('feathercode:'))
      out = {
        sections: [
          { id: 'feathercode:system', text: systemPrompt(e.tools), scope: 'shared' as const },
          ...others.filter(s => s.scope === 'shared'),
          ...others.filter(s => s.scope === 'session'),
        ],
      }
    }
    const rec = ctx.stats.compose(out.sections)
    if (rec) writeLog(ctx.log, { t: Date.now(), ev: 'compose', model: e.model, traits: e.traits, tools: e.tools.length, engine: r.sections.map(s => ({ id: s.id, chars: s.text.length })), ...rec })
    return out
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const out = has('prompt') ? { ...r, blocks: r.blocks.filter(b => b.name !== 'userEmail') } : r
    writeLog(ctx.log, { t: Date.now(), ev: 'context', blocks: out.blocks.map(b => ({ name: b.name, chars: b.text.length })) })
    return out
  })

  // ---- attachments (phase 2) -------------------------------------------------

  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    let text = r.text
    if (has('cache') && text !== null && e.origin.kind === 'engine') {
      if (DROPPED_ATTACHMENTS.has(e.type)) text = null
      else if (e.type === 'skill_listing') text = compactSkillListing(text)
      else if (e.type === 'session_context') text = stripGitStatus(text) ?? null
    }
    const chars = text === null ? null : text.length
    ctx.stats.attachment(e.type, e.agentId, chars)
    writeLog(ctx.log, { t: Date.now(), ev: 'attach', type: e.type, loop: e.agentId ?? 'main', origin: e.origin.kind, inChars: e.text.length, chars })
    return { text }
  })

  // ---- tools (phase 3) -------------------------------------------------------

  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    let out = r
    if (has('tools') && e.provider.plugin === 'engine') {
      const description = TOOL_DESCRIPTIONS[e.tool] ?? r.description
      const isDeferred = deferralFor(e.tool, r.isDeferred ?? e.isDeferred === true, { pin: new Set() })
      out = isDeferred === undefined ? { ...r, description } : { ...r, description, isDeferred }
    }
    const deferred = out.isDeferred ?? e.isDeferred === true
    if (ctx.stats.describe(e.tool, out.description.length, deferred)) {
      writeLog(ctx.log, {
        t: Date.now(),
        ev: 'describe',
        tool: e.tool,
        provider: e.provider.plugin,
        inChars: e.description.length,
        inDeferred: e.isDeferred === true,
        chars: out.description.length,
        deferred,
      })
    }
    return out
  })

  on('tool.call', async ($, e, next) => {
    ctx.stats.toolCall(e.tool, e.agentId, e as unknown as Record<string, unknown>)
    writeLog(ctx.log, { t: Date.now(), ev: 'tool', tool: e.tool, loop: e.agentId ?? 'main' })
    return next(e)
  })

  // ---- build / plan (phase 4) ------------------------------------------------

  // Plan mode: Edit / Write / NotebookEdit only inside the plan directory.
  // The hook never answers allow itself: outside plan mode, for other tools
  // and for a path inside the plan directory it returns the engine's own
  // verdict (`next(e)`); otherwise it denies. The event is read, never passed
  // on or written: the path is read here as a string.
  on('tool.check', async ($, e, next) => {
    const isEdit = e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit'
    if (!isEdit || !has('modes')) return next(e)
    if (ctx.mode !== 'plan') return next(e)
    const raw =
      e.tool === 'NotebookEdit'
        ? (e.input as { notebook_path?: unknown } | null)?.notebook_path
        : (e.input as { file_path?: unknown } | null)?.file_path
    const dir = planDir(ctx.root)
    if (typeof raw === 'string' && isInside(raw, dir)) return next(e)
    return { decision: 'deny', reason: planDenied(e.tool, dir) }
  }).catch(($, e, next) =>
    e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit'
      ? { decision: 'deny' as const, reason: 'feathercode: plan mode check failed' }
      : next(e),
  )

  on('command.run', { command: 'fc-plan' }, async $ => ({ text: await switchMode($, ctx, 'plan') }))
  on('command.run', { command: 'fc-build' }, async $ => ({ text: await switchMode($, ctx, 'build') }))

  // The band above the prompt: one flat row in the style of the rows it sits
  // beside (dot + mode, figures, dim details, plain buttons at the right).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const isPlan = has('modes') && ctx.mode === 'plan'
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = status(ctx.stats, ctx.mode, ctx.percent)
    const toggle = () => switchMode($, ctx, isPlan ? 'build' : 'plan')
    // bodyColumns counts terminal cells; a graphical surface draws Buttons wider, so it gets no fixed width.
    const width = e.surface === 'terminal' ? e.props.bodyColumns : undefined
    return (
      <Box flexDirection="row" alignItems="center" gap={2} width={width}>
        <Button key="mode" plain onPress={toggle}>
          <Text color={isPlan ? 'planMode' : 'claude'}>●</Text> {isPlan ? 'plan' : 'build'}
        </Button>
        {s.ctx !== undefined && <Text color={s.ctx >= 85 ? 'error' : s.ctx >= 70 ? 'warning' : undefined}>ctx {s.ctx}%</Text>}
        {s.requests > 0 && <Text color={s.cache < 80 ? 'warning' : undefined}>cache {s.cache}%</Text>}
        {s.requests > 0 && (
          <Text dimColor>
            {s.requests} req · in {s.input} · out {s.output}
          </Text>
        )}
        {s.breaks > 0 && (
          <Text color="warning">
            ⚠ {s.breaks} break{s.breaks === 1 ? '' : 's'}
          </Text>
        )}
        {isPlan && <Text dimColor>edits only in .opencode/plan</Text>}
        <Box flexGrow={1} />
        <Button key="stats" plain label="Stats" onPress={() => openPanel($)} />
        {has('modes') && <Button key="switch" plain label={isPlan ? 'Build' : 'Plan'} onPress={toggle} />}
      </Box>
    )
  })

  // ---- subagents (phase 4) ---------------------------------------------------

  on('agent.offer', async ($, e, next) => {
    if (has('agents') && ctx.agentsReady && REPLACED_AGENTS.has(e.agent) && e.provider.plugin === 'engine') {
      return { isOffered: false }
    }
    return next(e)
  })

  // ---- compaction (phase 5) --------------------------------------------------

  on('session.compact', async ($, e, next) => {
    const r = has('compact') ? await compact($, ctx, e, next) : await next(e)
    const isSkip = 'skip' in r && typeof r.skip === 'string'
    const before = 'tokensBefore' in r ? r.tokensBefore : undefined
    const after = 'tokensAfter' in r ? r.tokensAfter : undefined
    if (e.trigger !== 'precompute' && !isSkip) ctx.stats.compact(e.trigger, e.agentId, before, after)
    writeLog(ctx.log, {
      t: Date.now(),
      ev: 'compact',
      trigger: e.trigger,
      loop: e.agentId ?? 'main',
      before,
      after,
      messagesIn: e.messages.length,
      messagesOut: r.messages?.length,
      skip: isSkip ? r.skip : undefined,
    })
    await flush($, ctx)
    return r
  })

  // ---- turns -----------------------------------------------------------------

  on('turn.step', async function* ($, e, next) {
    const started = Date.now()
    const r = yield* next(e)
    const rec = ctx.stats.step(e, r.usage, started, Date.now())
    writeLog(ctx.log, { t: started, ev: 'step', ...rec, ms: Date.now() - started, stop: r.stopReason, tools: r.toolUses.map(t => t.name) })
    showStatus($, ctx)
    void flush($, ctx)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    writeLog(ctx.log, { t: Date.now(), ev: 'turn', loop: e.agentId ?? 'main', turnId: e.turnId, ms: e.durationMs, reason: e.reason })
    if (e.agentId === undefined && ctx.cfg.compactionPrune && has('compact')) ctx.pendingPrune = true
    $.ui.invalidate('ui.render')
    await flush($, ctx)
    return next(e)
  })

  // ---- stats -----------------------------------------------------------------

  on('command.run', { command: 'feathercode-stats' }, async () => ({ text: statsText(ctx) }))

  on('command.run', { command: 'feathercode-panel' }, async $ => {
    if ((await $.session.surfaces()).length === 0) return { text: statsText(ctx) }
    await openPanel($)
    return { text: 'feathercode panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = statsText(ctx).split('\n')
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text>{line}</Text>
        ))}
      </Box>
    )
  })
}

// ---- helpers (all `$` use stays in this file) ---------------------------------

async function loadCtx($: EngineInterface, ctx: Ctx): Promise<void> {
  ctx.root = await $.session.root()
  ctx.sessionId = await $.session.id()
  let existing: string | undefined
  try {
    const text = await $.fs.read(`${$.plugin.root}/logs/${ctx.sessionId}.jsonl`)
    if (typeof text === 'string') existing = text
  } catch {
    existing = undefined
  }
  attachLog(ctx.log, ctx.sessionId, existing)
  const v = await $.session.version()
  writeLog(ctx.log, {
    t: Date.now(),
    ev: 'start',
    session: ctx.sessionId,
    version: v.version,
    model: await $.session.model(),
    surfaces: await $.session.surfaces(),
    cwd: await $.session.cwd(),
    features: [...ctx.cfg.features],
  })
  await flush($, ctx)
}

/**
 * The one file the mod writes: its JSONL log, `<plugin>/logs/<session>.jsonl`
 * (`<session>.<n>.jsonl` past 3.5 MB).
 */
async function flush($: EngineInterface, ctx: Ctx): Promise<void> {
  const w = takeFlush(ctx.log)
  if (!w) return ctx.log.writing
  ctx.log.writing = ctx.log.writing.then(() => $.fs.write(`${$.plugin.root}/logs/${w.file}`, w.text)).catch(() => undefined)
  return ctx.log.writing
}

async function openPanel($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'feathercode' })
}

/** Redraws the band with the latest figures. */
function showStatus($: EngineInterface, ctx: Ctx): void {
  $.ui.invalidate('ui.render')
}

function statsText(ctx: Ctx): string {
  return formatStats(ctx.stats, ctx.log.file ? `<plugin>/logs/${ctx.log.file}` : undefined, [
    `features: ${[...ctx.cfg.features].join(',') || 'observe only'} | mode: ${ctx.mode}`,
  ])
}

/** Switches agent: records the mode and appends v2's one-shot reminder. */
async function switchMode($: EngineInterface, ctx: Ctx, mode: Mode): Promise<string> {
  if (ctx.mode === mode) return `Already in ${mode} mode.`
  ctx.mode = mode
  await $.store.set(`mode:${ctx.sessionId}`, mode)
  $.ui.invalidate('ui.render')
  showStatus($, ctx)
  const dir = planDir(ctx.root)
  const reminder = mode === 'plan' ? planEnter(dir) : PLAN_LEAVE
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: reminder }] } })
  } catch (err) {
    writeLog(ctx.log, { t: Date.now(), ev: 'error', where: 'switchMode.append', error: String(err) })
  }
  writeLog(ctx.log, { t: Date.now(), ev: 'mode', mode })
  ctx.stats.noteAll(`mode→${mode}`)
  return mode === 'plan'
    ? `Plan mode: read-only. Edits are allowed only in ${dir}. /fc-build to switch back.`
    : 'Build mode: full tool access. /fc-plan for read-only planning.'
}

/** A resumed session (`--continue`, `--resume`) gets its mode back. */
async function restoreMode($: EngineInterface, ctx: Ctx): Promise<void> {
  const saved = await $.store.get(`mode:${ctx.sessionId}`)
  if (saved === 'plan' || saved === 'build') ctx.mode = saved
}

async function registerAgents($: EngineInterface, ctx: Ctx): Promise<void> {
  try {
    await $.agent.register({
      name: 'explore',
      description: EXPLORE_DESCRIPTION,
      prompt: EXPLORE_PROMPT,
      tools: ['Bash', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'],
      model: 'inherit',
    })
    await $.agent.register({
      name: 'general',
      description: GENERAL_DESCRIPTION,
      prompt: systemPrompt(['Bash', 'Write', 'Edit']),
      disallowedTools: ['AskUserQuestion', 'Agent'],
      model: 'inherit',
    })
    ctx.agentsReady = true
  } catch (err) {
    writeLog(ctx.log, { t: Date.now(), ev: 'error', where: 'registerAgents', error: String(err) })
  }
}

/** Opt-in v1 prune, between turns, when clearing old tool outputs frees enough. */
async function requestPrune($: EngineInterface, ctx: Ctx): Promise<void> {
  if (ctx.compacting) return
  const current = await $.session.messages()
  if ('deny' in current || planPrune(current as readonly Msg[]).ids.size === 0) {
    ctx.pendingPrune = false
    return
  }
  ctx.compacting = true
  try {
    writeLog(ctx.log, { t: Date.now(), ev: 'compact-request', reason: 'prune' })
    await $.session.compact()
  } catch (err) {
    // Headless (-p / SDK) sessions refuse $.session.compact between turns; a
    // queued /compact with the prune marker runs as a turn of its own.
    writeLog(ctx.log, { t: Date.now(), ev: 'error', where: 'requestPrune', error: String(err) })
    if (/headless/.test(String(err))) {
      try {
        await $.command.run({ command: 'compact', args: PRUNE_MARK })
        writeLog(ctx.log, { t: Date.now(), ev: 'compact-request', reason: 'prune', via: 'command' })
      } catch (err2) {
        writeLog(ctx.log, { t: Date.now(), ev: 'error', where: 'requestPrune.command', error: String(err2) })
      }
    }
  } finally {
    ctx.compacting = false
  }
}

/** OpenCode v2 compaction in place of the engine's (prune: v1, opt-in). */
async function compact(
  $: EngineInterface,
  ctx: Ctx,
  e: SessionCompactInput,
  next: (e: SessionCompactInput) => Promise<SessionCompactResult>,
): Promise<SessionCompactResult> {
  if (e.trigger === 'precompute') return { skip: 'feathercode compacts on demand' }
  const messages = e.messages as readonly Msg[]
  if ((e.trigger === 'plugin' && ctx.pendingPrune) || e.instructions === PRUNE_MARK) {
    ctx.pendingPrune = false
    const plan = planPrune(messages)
    if (plan.ids.size === 0) return { skip: 'nothing to prune' }
    const pruned = applyPrune(messages, plan)
    writeLog(ctx.log, { t: Date.now(), ev: 'prune', outputs: plan.ids.size, tokens: plan.tokens })
    return { messages: pruned as SessionMessage[] }
  }
  if (e.trigger === 'auto' && !ctx.cfg.compactionAuto) return { skip: 'auto compaction is off (feathercode compaction_auto)' }
  // A subagent's loop: fork reads only the main thread, so the engine compacts it.
  if (e.agentId !== undefined) return next(e)

  const split = splitConversation(messages, ctx.cfg.keepTokens)
  if (!split || split.start === 0) return { skip: 'nothing to compact' }
  const update = isCheckpoint(messages[0])
  const keptFrom = split.start < messages.length ? messages[split.start]!.text.trim().split('\n')[0]!.slice(0, 80) : undefined
  const prompt = buildPrompt(update, keptFrom, e.instructions)

  let summary: string | undefined
  let r = await $.model.fork({ prompt })
  if (r.isAnswered && !hasTemplate(r.text)) r = await $.model.fork({ prompt: `${prompt}\n\n${NUDGE}` })
  if (r.isAnswered) summary = r.text
  writeLog(ctx.log, {
    t: Date.now(),
    ev: 'summary',
    via: 'fork',
    ok: r.isAnswered,
    reason: r.isAnswered ? undefined : r.reason,
    usage: 'usage' in r ? r.usage : undefined,
  })
  if (summary === undefined) {
    // dev's text fallback (the fork did not fit or failed): the history before
    // the kept tail as one text, exchanges shortened oldest first to fit.
    const system = systemPrompt(['Bash', 'Write', 'Edit'])
    const textPrompt = buildPrompt(update, undefined, e.instructions)
    const room = (ctx.window || UNKNOWN_WINDOW) - SUMMARY_ROOM - estimate(system) - estimate(textPrompt) - estimate(NUDGE)
    const older = flattenHistory(messages.slice(0, split.start), room)
    if (older === undefined) return next(e)
    const c = await $.model.complete({
      model: await $.session.model(),
      system,
      prompt: `${older}\n\n${textPrompt}`,
      maxTokens: SUMMARY_ROOM,
    })
    writeLog(ctx.log, { t: Date.now(), ev: 'summary', via: 'complete', ok: c.isAnswered, usage: c.usage })
    if (!c.isAnswered) return next(e)
    summary = c.text
  }

  const reminder = ctx.mode === 'plan' && ctx.cfg.features.has('modes') ? `\n\n${planEnter(planDir(ctx.root))}` : ''
  const tokensBefore = messages.reduce((n, m) => n + messageTokens(m), 0)
  let out: Msg[]
  if (ctx.cfg.compactionTail === 'messages') {
    out = [{ role: 'user', text: checkpoint(summary, '') + reminder, toolUses: [] }, ...messages.slice(split.start)]
  } else {
    out = [{ role: 'user', text: checkpoint(summary, split.recent) + reminder, toolUses: [] }]
  }
  const tokensAfter = out.reduce((n, m) => n + messageTokens(m), 0)
  return { messages: out as SessionMessage[], tokensBefore, tokensAfter }
}
