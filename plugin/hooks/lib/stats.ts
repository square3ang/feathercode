/**
 * Observation state (pure): what the request is made of (system sections,
 * tool descriptions, injected attachments) and what each request cost (input /
 * output / cache read / cache write). A request whose cache read falls short of
 * the previous request's whole prompt in the same loop is a cache break; the
 * events seen in between are kept as its candidate causes.
 */

export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type StepInput = {
  turnId: string
  index: number
  model: string
  effort?: string | number
  messageCount: number
  agentId?: string
}

export type StepRecord = {
  loop: string
  turnId: string
  index: number
  model: string
  effort?: string | number
  messages: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  isBreak: boolean
  lost: number
  causes: string[]
  gapMs: number
}

type LoopState = {
  lastTotal: number
  lastModel: string
  lastEffort?: string | number
  lastSys: string
  lastTools: number
  lastAt: number
  pending: string[]
}

export type Section = { id: string; scope: string; text: string }

/** Shortfall tolerated before a request counts as a cache break, in tokens. */
export const BREAK_TOLERANCE = 1024
/** The prompt cache lifetime Claude Code requests (1h); a gap past it explains a miss. */
export const CACHE_TTL_MS = 60 * 60_000

export class Stats {
  steps: StepRecord[] = []
  attachments = new Map<string, { count: number; chars: number; dropped: number }>()
  sections: { id: string; scope: string; chars: number }[] = []
  sysHash = ''
  sysChanges = 0
  tools = new Map<string, { chars: number; deferred: boolean }>()
  toolSearches = 0
  compactions: { trigger: string; before?: number; after?: number }[] = []
  private loops = new Map<string, LoopState>()

  private loop(id: string): LoopState {
    let s = this.loops.get(id)
    if (!s) {
      s = { lastTotal: 0, lastModel: '', lastSys: '', lastTools: 0, lastAt: 0, pending: [] }
      this.loops.set(id, s)
    }
    return s
  }

  note(loopId: string | undefined, what: string): void {
    const s = this.loop(loopId ?? 'main')
    if (s.pending.length < 40) s.pending.push(what)
  }

  noteAll(what: string): void {
    if (this.loops.size === 0) this.loop('main')
    for (const s of this.loops.values()) if (s.pending.length < 40) s.pending.push(what)
  }

  /** A rendered system prompt; returns the log record when it changed. */
  compose(sections: readonly Section[]): Record<string, unknown> | undefined {
    const h = hash(sections.map(s => `${s.scope}\u0000${s.id}\u0000${s.text}`).join('\u0001'))
    if (h === this.sysHash) return undefined
    if (this.sysHash !== '') {
      this.sysChanges++
      this.noteAll('system prompt changed')
    }
    this.sysHash = h
    this.sections = sections.map(s => ({ id: s.id, scope: s.scope, chars: s.text.length }))
    return { hash: h, sections: this.sections }
  }

  /** A tool description; true the first time the tool is seen. */
  describe(tool: string, chars: number, deferred: boolean): boolean {
    const isNew = !this.tools.has(tool)
    this.tools.set(tool, { chars, deferred })
    return isNew
  }

  attachment(type: string, loopId: string | undefined, chars: number | null): void {
    const a = this.attachments.get(type) ?? { count: 0, chars: 0, dropped: 0 }
    a.count++
    if (chars === null) a.dropped++
    else a.chars += chars
    this.attachments.set(type, a)
    this.note(loopId, `attachment:${type}${chars === null ? '(dropped)' : ''}`)
  }

  toolCall(tool: string, loopId: string | undefined, input: Record<string, unknown>): void {
    if (tool === 'ToolSearch') {
      this.toolSearches++
      this.note(loopId, `ToolSearch(${String(input.query ?? '')})`)
    } else if (tool === 'Skill') {
      this.note(loopId, `Skill(${String(input.skill ?? '')})`)
    } else if (tool === 'EnterPlanMode' || tool === 'ExitPlanMode') {
      this.note(loopId, tool)
    }
  }

  compact(trigger: string, loopId: string | undefined, before?: number, after?: number): void {
    this.compactions.push({ trigger, before, after })
    this.note(loopId, `compaction(${trigger})`)
  }

  /** One finished model request. */
  step(e: StepInput, usage: Usage | null, startedAt: number, endedAt: number): StepRecord {
    const loopId = e.agentId ?? 'main'
    const s = this.loop(loopId)
    const rec: StepRecord = {
      loop: loopId,
      turnId: e.turnId,
      index: e.index,
      model: e.model,
      effort: e.effort,
      messages: e.messageCount,
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
      isBreak: false,
      lost: 0,
      causes: [],
      gapMs: s.lastAt > 0 ? startedAt - s.lastAt : 0,
    }
    if (usage && s.lastTotal > 0 && rec.cacheRead + BREAK_TOLERANCE < s.lastTotal) {
      rec.isBreak = true
      rec.lost = s.lastTotal - rec.cacheRead
      const causes = [...s.pending]
      if (s.lastModel && s.lastModel !== e.model) causes.push(`model ${s.lastModel}→${e.model}`)
      if (s.lastEffort !== e.effort) causes.push(`effort ${String(s.lastEffort)}→${String(e.effort)}`)
      if (s.lastSys && s.lastSys !== this.sysHash) causes.push('system prompt hash')
      if (s.lastTools && s.lastTools !== this.tools.size) causes.push(`tool set ${s.lastTools}→${this.tools.size}`)
      if (rec.gapMs > CACHE_TTL_MS) causes.push(`idle ${Math.round(rec.gapMs / 60_000)}m (TTL)`)
      rec.causes = causes
    }
    if (usage) {
      s.lastTotal = rec.input + rec.cacheRead + rec.cacheWrite
      s.lastModel = e.model
      s.lastEffort = e.effort
      s.lastSys = this.sysHash
      s.lastTools = this.tools.size
      s.pending = []
    }
    s.lastAt = endedAt
    this.steps.push(rec)
    return rec
  }

  totals() {
    const t = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, breaks: 0, lost: 0 }
    for (const s of this.steps) {
      t.requests++
      t.input += s.input
      t.output += s.output
      t.cacheRead += s.cacheRead
      t.cacheWrite += s.cacheWrite
      if (s.isBreak) {
        t.breaks++
        t.lost += s.lost
      }
    }
    return t
  }
}

export function formatStats(stats: Stats, logPath: string | undefined, extra: string[] = []): string {
  const t = stats.totals()
  const prompt = t.input + t.cacheRead + t.cacheWrite
  const hit = prompt > 0 ? ((100 * t.cacheRead) / prompt).toFixed(1) : '0.0'
  const shared = stats.sections.filter(s => s.scope === 'shared').reduce((n, s) => n + s.chars, 0)
  const session = stats.sections.filter(s => s.scope === 'session').reduce((n, s) => n + s.chars, 0)
  const listed = [...stats.tools.values()].filter(t => !t.deferred)
  const lines = [
    'feathercode stats',
    ...extra,
    `requests ${t.requests} | input ${t.input} | output ${t.output} | cache read ${t.cacheRead} | cache write ${t.cacheWrite} | hit ${hit}%`,
    `cache breaks ${t.breaks} (~${t.lost} tokens re-written) | ToolSearch calls ${stats.toolSearches} | compactions ${stats.compactions.length}`,
    `system prompt: ${stats.sections.length} sections, shared ${shared} chars, session ${session} chars, changed ${stats.sysChanges}x`,
    `tools: ${listed.length} listed (${listed.reduce((n, t) => n + t.chars, 0)} desc chars), ${stats.tools.size - listed.length} deferred`,
  ]
  const att = [...stats.attachments.entries()].sort((a, b) => b[1].chars - a[1].chars)
  if (att.length > 0) {
    lines.push(
      'attachments: ' +
        att.map(([k, v]) => `${k}x${v.count} (${v.chars}c${v.dropped ? `, ${v.dropped} dropped` : ''})`).join(', '),
    )
  }
  for (const b of stats.steps.filter(s => s.isBreak).slice(-5)) {
    lines.push(`  break ${b.loop} ${b.turnId.slice(0, 8)}/${b.index}: lost ${b.lost}, causes: ${b.causes.join('; ') || 'unknown'}`)
  }
  if (logPath) lines.push(`log: ${logPath}`)
  return lines.join('\n')
}
