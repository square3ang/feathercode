// feathercode — an OpenCode-style harness for Claude Code.
// Portions ported from OpenCode (https://github.com/anomalyco/opencode),
// Copyright (c) 2025 opencode, MIT License. See ../LICENSE and ../NOTICE.md.
//
// Every hook and every `$` call lives in this file (the engine follows `$`
// only into functions declared here); ./lib holds the pure logic.
import type { EngineInterface, Register } from 'claude-code'

import { parseFeatures, resolveConfig, type Config } from './lib/config'
import { attachLog, createLog, takeFlush, writeLog, type JsonlLog } from './lib/log'
import { Stats, formatStats } from './lib/stats'

type Ctx = {
  cfg: Config
  log: JsonlLog
  stats: Stats
  dump: Record<string, unknown>
  dumpPath?: string
}

export const register: Register = (on, options) => {
  const o = options as Record<string, unknown>
  const ctx: Ctx = {
    cfg: resolveConfig(o, { home: '~', features: undefined }),
    log: createLog(),
    stats: new Stats(),
    dump: {},
  }
  ctx.cfg.features = parseFeatures(typeof o.features === 'string' ? o.features : 'all')

  on('session.start', async ($, e, next) => {
    await loadCtx($, ctx, o)
    await $.command.register({ name: 'feathercode-stats', description: 'Token and prompt-cache usage of this session' })
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
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!('sections' in r) || !r.sections) return r
    const rec = ctx.stats.compose(r.sections)
    if (rec) writeLog(ctx.log, { t: Date.now(), ev: 'compose', model: e.model, traits: e.traits, tools: e.tools.length, ...rec })
    await dump($, ctx, 'compose', { input: e, sections: r.sections })
    return r
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    writeLog(ctx.log, { t: Date.now(), ev: 'context', blocks: r.blocks.map(b => ({ name: b.name, chars: b.text.length })) })
    await dump($, ctx, 'context', { input: e, out: r })
    return r
  })

  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    const chars = r.text === null ? null : r.text.length
    ctx.stats.attachment(e.type, e.agentId, chars)
    writeLog(ctx.log, { t: Date.now(), ev: 'attach', type: e.type, loop: e.agentId ?? 'main', origin: e.origin.kind, inChars: e.text.length, chars })
    await dump($, ctx, 'attachments', { in: e, out: r }, true)
    return r
  })

  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    const deferred = r.isDeferred ?? e.isDeferred === true
    if (ctx.stats.describe(e.tool, r.description.length, deferred)) {
      writeLog(ctx.log, {
        t: Date.now(),
        ev: 'describe',
        tool: e.tool,
        provider: e.provider.plugin,
        inChars: e.description.length,
        inDeferred: e.isDeferred === true,
        chars: r.description.length,
        deferred,
      })
    }
    await dump($, ctx, 'tools', { tool: e.tool, inDeferred: e.isDeferred, in: e.description, out: r }, true)
    return r
  })

  on('tool.call', async ($, e, next) => {
    ctx.stats.toolCall(e.tool, e.agentId, e as unknown as Record<string, unknown>)
    writeLog(ctx.log, { t: Date.now(), ev: 'tool', tool: e.tool, loop: e.agentId ?? 'main' })
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
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

  on('turn.step', async function* ($, e, next) {
    const started = Date.now()
    const r = yield* next(e)
    const rec = ctx.stats.step(e, r.usage, started, Date.now())
    writeLog(ctx.log, { t: started, ev: 'step', ...rec, ms: Date.now() - started, stop: r.stopReason, tools: r.toolUses.map(t => t.name) })
    void flush($, ctx)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    writeLog(ctx.log, { t: Date.now(), ev: 'turn', loop: e.agentId ?? 'main', turnId: e.turnId, ms: e.durationMs, reason: e.reason })
    await flush($, ctx)
    return next(e)
  })

  on('command.run', { command: 'feathercode-stats' }, async () => ({
    text: formatStats(ctx.stats, ctx.log.path, [`features: ${[...ctx.cfg.features].join(',') || 'observe only'}`]),
  }))
}

async function loadCtx($: EngineInterface, ctx: Ctx, options: Record<string, unknown>): Promise<void> {
  ctx.cfg = resolveConfig(options, {
    features: await $.env.get('FEATHERCODE_FEATURES'),
    logDir: await $.env.get('FEATHERCODE_LOG_DIR'),
    prune: await $.env.get('FEATHERCODE_PRUNE'),
    home: (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.',
  })
  ctx.dumpPath = await $.env.get('FEATHERCODE_DUMP')
  const id = await $.session.id()
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
