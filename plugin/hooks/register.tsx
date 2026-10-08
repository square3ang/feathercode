// feathercode — an OpenCode-style harness for Claude Code.
// Portions ported from OpenCode (https://github.com/anomalyco/opencode, branch v2),
// Copyright (c) 2025 opencode, MIT License. See ../NOTICE.md.
//
// Every hook and every `$` call lives in this file (the engine follows `$`
// only into functions declared here); ./lib holds the pure logic.
import type { EngineInterface, Register, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'

import {
  NUDGE,
  applyPrune,
  buildPrompt,
  ceiling,
  checkpoint,
  hasTemplate,
  isCheckpoint,
  messageToText,
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
  findPolicy,
  planDenied,
  planEnter,
  stripGitStatus,
  systemPrompt,
} from './lib/prompts'
import { Stats, formatStats } from './lib/stats'
import { deferralFor } from './lib/tools'

const PANE = 'feathercode-stats'
/** /compact instructions that ask for a prune (headless sessions queue one). */
const PRUNE_MARK = '__feathercode_prune__'
/** Built-in agent types the feathercode ones replace. */
const REPLACED_AGENTS = new Set(['Explore', 'general-purpose', 'Plan', 'claude'])
/** Fallback for the engine's security line until a compose has shown it. */
const POLICY_FALLBACK =
  'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.'

type Ctx = {
  cfg: Config
  log: JsonlLog
  stats: Stats
  /** The session's project root; the plan directory lives under it. */
  root: string
  sessionId: string
  mode: Mode
  policy?: string
  commands: { plan: string; build: string }
  agentsReady: boolean
  pendingPrune: boolean
  compacting: boolean
  /** The last main-loop request's input + cache read/write + output (v2's measured size). */
  lastMainTokens: number
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
    commands: { plan: 'plan', build: 'build' },
    agentsReady: false,
    pendingPrune: false,
    compacting: false,
    lastMainTokens: 0,
  }
  const has = (f: Feature) => ctx.cfg.features.has(f)

  // ---- session ---------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await loadCtx($, ctx)
    await $.command.register({ name: 'feathercode-stats', description: 'Token and prompt-cache usage of this session' })
    await $.command.register({ name: 'feathercode-panel', description: 'Show token and prompt-cache usage in a pane' })
    if (has('modes')) {
      await registerModeCommands($, ctx)
      await restoreMode($, ctx)
    }
    if (has('agents')) await registerAgents($, ctx)
    if (ctx.cfg.panel && (await $.session.surfaces()).length > 0) void $.ui.open({ id: PANE, title: 'feathercode' })
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
      if (has('compact')) await maybeCompact($, ctx, Math.max(e.context.tokens ?? 0, ctx.lastMainTokens), e.context.window)
    }
    return next(e)
  })

  // ---- system prompt (phase 1) -----------------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!('sections' in r) || !r.sections) return r
    let out = r
    if (has('prompt') && e.outputStyle === null && !e.traits.includes('bare')) {
      ctx.policy = findPolicy(r.sections.map(s => s.text)) ?? ctx.policy
      const others = r.sections.filter(s => s.id.includes(':') && !s.id.startsWith('feathercode:'))
      out = {
        sections: [
          { id: 'feathercode:system', text: systemPrompt(e.tools, ctx.policy ?? POLICY_FALLBACK), scope: 'shared' as const },
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

  on('command.run', { command: 'plan' }, async $ => ({ text: await switchMode($, ctx, 'plan') }))
  on('command.run', { command: 'build' }, async $ => ({ text: await switchMode($, ctx, 'build') }))
  on('command.run', { command: 'fc-plan' }, async $ => ({ text: await switchMode($, ctx, 'plan') }))
  on('command.run', { command: 'fc-build' }, async $ => ({ text: await switchMode($, ctx, 'build') }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!has('modes') || e.props.hasSurvey) return next(e)
    if (ctx.mode !== 'plan') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="yellow" bold>
          plan
        </Text>
        <Text dimColor> read-only: edits only in {planDir(ctx.root)} </Text>
        <Button key="build" label="Switch to build" onPress={() => switchMode($, ctx, 'build')} />
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
    if (e.agentId === undefined && r.usage) ctx.lastMainTokens = rec.input + rec.cacheRead + rec.cacheWrite + rec.output
    writeLog(ctx.log, { t: started, ev: 'step', ...rec, ms: Date.now() - started, stop: r.stopReason, tools: r.toolUses.map(t => t.name) })
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
    await $.ui.open({ id: PANE, title: 'feathercode' })
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

function statsText(ctx: Ctx): string {
  return formatStats(ctx.stats, ctx.log.file ? `<plugin>/logs/${ctx.log.file}` : undefined, [
    `features: ${[...ctx.cfg.features].join(',') || 'observe only'} | mode: ${ctx.mode}`,
  ])
}

/** `/plan` and `/build`; a built-in of that name keeps it, so fall back to fc-*. */
async function registerModeCommands($: EngineInterface, ctx: Ctx): Promise<void> {
  try {
    await $.command.register({ name: 'plan', description: 'Plan agent: read-only, edits only in the plan directory (OpenCode plan)' })
  } catch {
    ctx.commands.plan = 'fc-plan'
    await $.command.register({ name: 'fc-plan', description: 'Plan agent: read-only, edits only in the plan directory (OpenCode plan)' })
  }
  try {
    await $.command.register({ name: 'build', description: 'Build agent: the default, full tool access (OpenCode build)' })
  } catch {
    ctx.commands.build = 'fc-build'
    await $.command.register({ name: 'fc-build', description: 'Build agent: the default, full tool access (OpenCode build)' })
  }
}

/** Switches agent: records the mode and appends v2's one-shot reminder. */
async function switchMode($: EngineInterface, ctx: Ctx, mode: Mode): Promise<string> {
  if (ctx.mode === mode) return `Already in ${mode} mode.`
  ctx.mode = mode
  await $.store.set(`mode:${ctx.sessionId}`, mode)
  $.ui.invalidate('ui.render')
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
    ? `Plan mode: read-only. Edits are allowed only in ${dir}. /${ctx.commands.build} to switch back.`
    : `Build mode: full tool access. /${ctx.commands.plan} for read-only planning.`
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
      prompt: systemPrompt(['Bash', 'Write', 'Edit'], ctx.policy ?? POLICY_FALLBACK),
      disallowedTools: ['AskUserQuestion', 'Agent'],
      model: 'inherit',
    })
    ctx.agentsReady = true
  } catch (err) {
    writeLog(ctx.log, { t: Date.now(), ev: 'error', where: 'registerAgents', error: String(err) })
  }
}

/** v2's trigger: between turns, once the context reaches the ceiling; prune when it frees enough. */
async function maybeCompact($: EngineInterface, ctx: Ctx, tokens: number, window: number): Promise<void> {
  if (ctx.compacting) return
  const limit = ceiling(window, ctx.cfg.compactionBuffer || undefined)
  const due = ctx.cfg.compactionAuto && tokens >= limit
  if (!due && ctx.pendingPrune) {
    const current = await $.session.messages()
    if ('deny' in current || planPrune(current as readonly Msg[]).ids.size === 0) ctx.pendingPrune = false
  }
  if (!due && !ctx.pendingPrune) return
  ctx.compacting = true
  const reason = due ? 'ceiling' : 'prune'
  try {
    if (due) ctx.pendingPrune = false
    writeLog(ctx.log, { t: Date.now(), ev: 'compact-request', reason, tokens, limit })
    await $.session.compact()
  } catch (err) {
    // Headless (-p / SDK) sessions refuse $.session.compact between turns; a
    // queued /compact runs as a turn of its own, with the prune marker as its
    // instructions when that is what was asked.
    writeLog(ctx.log, { t: Date.now(), ev: 'error', where: 'maybeCompact', error: String(err) })
    if (/headless/.test(String(err))) {
      try {
        await $.command.run({ command: 'compact', args: reason === 'prune' ? PRUNE_MARK : '' })
        writeLog(ctx.log, { t: Date.now(), ev: 'compact-request', reason, via: 'command' })
      } catch (err2) {
        writeLog(ctx.log, { t: Date.now(), ev: 'error', where: 'maybeCompact.command', error: String(err2) })
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
    // v2's own fallback form: the older part flattened into one message.
    const older = messages.slice(0, split.start).map(messageToText).filter(Boolean).join('\n\n')
    const c = await $.model.complete({
      model: await $.session.model(),
      system: systemPrompt(['Bash', 'Write', 'Edit'], ctx.policy ?? POLICY_FALLBACK),
      prompt: `${older}\n\n${buildPrompt(update, undefined, e.instructions)}`,
      maxTokens: 8000,
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
