// feathercode — an OpenCode-style harness for Claude Code.
// Portions ported from OpenCode (https://github.com/anomalyco/opencode, branch v2),
// Copyright (c) 2025 opencode, MIT License. See ../NOTICE.md.
//
// Every hook and every `$` call lives in this file (the engine follows `$`
// only into functions declared here); ./lib holds the pure logic.
import { read, update } from 'claude-code'
import type { EngineInterface, Register, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'

import type { FeathercodeMode } from '../types'
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
import { parseFeatures, resolveConfig, type Config, type Feature } from './lib/config'
import { attachLog, createLog, takeFlush, writeLog, type JsonlLog } from './lib/log'
import { planAllows, planDir, EDIT_TOOLS } from './lib/modes'
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

const MODE = { plugin: 'feathercode', key: 'mode' } as const
const STATS_VERSION = { plugin: 'feathercode', key: 'statsVersion' } as const
const PANE = 'feathercode-stats'
/** Built-in agent types the feathercode ones replace. */
const REPLACED_AGENTS = new Set(['Explore', 'general-purpose', 'Plan', 'claude'])
/** Fallback for the engine's security line until a compose has shown it. */
const POLICY_FALLBACK =
  'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.'

type Ctx = {
  cfg: Config
  log: JsonlLog
  stats: Stats
  dump: Record<string, unknown>
  dumpPath?: string
  home: string
  sessionId: string
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
    cfg: resolveConfig(o, { home: '~' }),
    log: createLog(),
    stats: new Stats(),
    dump: {},
    home: '~',
    sessionId: '',
    commands: { plan: 'plan', build: 'build' },
    agentsReady: false,
    pendingPrune: false,
    compacting: false,
    lastMainTokens: 0,
  }
  ctx.cfg.features = parseFeatures(typeof o.features === 'string' ? o.features : 'all')
  const has = (f: Feature) => ctx.cfg.features.has(f)

  // ---- session ---------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await loadCtx($, ctx, o)
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
    await dump($, ctx, 'compose', { input: e, sections: out.sections })
    return out
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const out = has('prompt') ? { ...r, blocks: r.blocks.filter(b => b.name !== 'userEmail') } : r
    writeLog(ctx.log, { t: Date.now(), ev: 'context', blocks: out.blocks.map(b => ({ name: b.name, chars: b.text.length })) })
    await dump($, ctx, 'context', { input: e, out })
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
    await dump($, ctx, 'attachments', { in: e, out: text }, true)
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
    await dump($, ctx, 'tools', { tool: e.tool, inDeferred: e.isDeferred, in: e.description, out }, true)
    return out
  })

  on('tool.call', async ($, e, next) => {
    ctx.stats.toolCall(e.tool, e.agentId, e as unknown as Record<string, unknown>)
    writeLog(ctx.log, { t: Date.now(), ev: 'tool', tool: e.tool, loop: e.agentId ?? 'main' })
    return next(e)
  })

  // ---- build / plan (phase 4) ------------------------------------------------

  on('tool.check', async ($, e, next) => {
    if (!has('modes') || !(e.tool in EDIT_TOOLS)) return next(e)
    const mode = (await $.state.get(MODE)).value ?? 'build'
    if (mode !== 'plan') return next(e)
    const dir = planDir(ctx.home)
    if (planAllows(e.tool, e.input, dir)) return next(e)
    return { decision: 'deny', reason: planDenied(e.tool, dir) }
  }).catch(($, e) => (e.tool in EDIT_TOOLS ? { decision: 'deny' as const, reason: 'feathercode: plan check failed' } : { decision: 'ask' as const }))

  on('command.run', { command: 'plan' }, async $ => ({ text: await switchMode($, ctx, 'plan') }))
  on('command.run', { command: 'build' }, async $ => ({ text: await switchMode($, ctx, 'build') }))
  on('command.run', { command: 'fc-plan' }, async $ => ({ text: await switchMode($, ctx, 'plan') }))
  on('command.run', { command: 'fc-build' }, async $ => ({ text: await switchMode($, ctx, 'build') }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!has('modes') || e.props.hasSurvey) return next(e)
    const mode = (await read($, { plugin: 'feathercode', key: 'mode' } as const)) ?? 'build'
    if (mode !== 'plan') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="yellow" bold>
          plan
        </Text>
        <Text dimColor> read-only: edits only in {planDir(ctx.home)} </Text>
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
    await bumpStats($)
    await flush($, ctx)
    return next(e)
  })

  // ---- stats -----------------------------------------------------------------

  on('command.run', { command: 'feathercode-stats' }, async $ => ({ text: await statsText($, ctx) }))

  on('command.run', { command: 'feathercode-panel' }, async $ => {
    if ((await $.session.surfaces()).length === 0) return { text: await statsText($, ctx) }
    await $.ui.open({ id: PANE, title: 'feathercode' })
    return { text: 'feathercode panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, { plugin: 'feathercode', key: 'statsVersion' } as const)
    const { Box, Text } = $.ui.resolve(e)
    const lines = (await statsText($, ctx)).split('\n')
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

async function loadCtx($: EngineInterface, ctx: Ctx, options: Record<string, unknown>): Promise<void> {
  ctx.home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  ctx.cfg = resolveConfig(options, {
    features: await $.env.get('FEATHERCODE_FEATURES'),
    logDir: await $.env.get('FEATHERCODE_LOG_DIR'),
    prune: await $.env.get('FEATHERCODE_PRUNE'),
    keep: await $.env.get('FEATHERCODE_KEEP_TOKENS'),
    buffer: await $.env.get('FEATHERCODE_COMPACT_BUFFER'),
    home: ctx.home,
  })
  ctx.dumpPath = await $.env.get('FEATHERCODE_DUMP')
  const id = await $.session.id()
  ctx.sessionId = id
  let existing: string | undefined
  const path = `${ctx.cfg.logDir.replace(/[\\/]$/, '')}/${id}.jsonl`
  try {
    if (await $.fs.exists(path)) {
      const text = await $.fs.read(path)
      if (typeof text === 'string') existing = text
    }
  } catch {
    existing = undefined
  }
  attachLog(ctx.log, ctx.cfg.logDir, id, existing)
  const v = await $.session.version()
  writeLog(ctx.log, {
    t: Date.now(),
    ev: 'start',
    session: id,
    version: v.version,
    model: await $.session.model(),
    surfaces: await $.session.surfaces(),
    cwd: await $.session.cwd(),
    features: [...ctx.cfg.features],
  })
  await flush($, ctx)
}

async function flush($: EngineInterface, ctx: Ctx): Promise<void> {
  const w = takeFlush(ctx.log)
  if (!w) return ctx.log.writing
  ctx.log.writing = ctx.log.writing.then(() => $.fs.write(w.path, w.text)).catch(() => undefined)
  return ctx.log.writing
}

/** FEATHERCODE_DUMP=<file>: the full prompt parts as computed (discovery). */
async function dump($: EngineInterface, ctx: Ctx, key: string, value: unknown, push = false): Promise<void> {
  if (!ctx.dumpPath) return
  if (push) ((ctx.dump[key] ??= []) as unknown[]).push(value)
  else ctx.dump[key] = value
  await $.fs.write(ctx.dumpPath, JSON.stringify(ctx.dump, null, 1))
}

async function statsText($: EngineInterface, ctx: Ctx): Promise<string> {
  const mode = (await $.state.get(MODE)).value ?? 'build'
  return formatStats(ctx.stats, ctx.log.path, [
    `features: ${[...ctx.cfg.features].join(',') || 'observe only'} | mode: ${mode}`,
  ])
}

async function bumpStats($: EngineInterface): Promise<void> {
  await update($, STATS_VERSION, n => (n ?? 0) + 1)
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
async function switchMode($: EngineInterface, ctx: Ctx, mode: FeathercodeMode): Promise<string> {
  const current = (await $.state.get(MODE)).value ?? 'build'
  if (current === mode) return `Already in ${mode} mode.`
  await $.state.set(MODE, mode)
  await $.store.set(`mode:${ctx.sessionId}`, mode)
  const dir = planDir(ctx.home)
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
  if (saved === 'plan' || saved === 'build') await $.state.set(MODE, saved)
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
  try {
    if (due) ctx.pendingPrune = false
    writeLog(ctx.log, { t: Date.now(), ev: 'compact-request', reason: due ? 'ceiling' : 'prune', tokens, limit })
    await $.session.compact()
  } catch (err) {
    writeLog(ctx.log, { t: Date.now(), ev: 'error', where: 'maybeCompact', error: String(err) })
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
  if (e.trigger === 'plugin' && ctx.pendingPrune) {
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

  const mode = (await $.state.get(MODE)).value ?? 'build'
  const reminder = mode === 'plan' && ctx.cfg.features.has('modes') ? `\n\n${planEnter(planDir(ctx.home))}` : ''
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
