export type Feature = 'prompt' | 'cache' | 'tools' | 'modes' | 'agents' | 'compact'

export const ALL_FEATURES: readonly Feature[] = ['prompt', 'cache', 'tools', 'modes', 'agents', 'compact']

export type Config = {
  features: ReadonlySet<Feature>
  compactionAuto: boolean
  compactionPrune: boolean
  keepTokens: number
  /** 0: OpenCode's max(10%, 16k) reserve. */
  compactionBuffer: number
  compactionTail: 'text' | 'messages'
  logDir: string
  panel: boolean
}

export function parseFeatures(text: string | undefined): Set<Feature> {
  const raw = (text ?? 'all').trim().toLowerCase()
  if (raw === '' || raw === 'all') return new Set(ALL_FEATURES)
  if (raw === 'observe' || raw === 'none') return new Set()
  const out = new Set<Feature>()
  for (const part of raw.split(',')) {
    const f = part.trim() as Feature
    if (ALL_FEATURES.includes(f)) out.add(f)
  }
  return out
}

export type Env = { features?: string; logDir?: string; prune?: string; keep?: string; home: string }

/** Options from userConfig, then env overrides (the bench runner uses env). */
export function resolveConfig(o: Record<string, unknown>, env: Env): Config {
  const configured = typeof o.log_dir === 'string' ? o.log_dir : ''
  let logDir = env.logDir || configured || `${env.home}/.claude/feathercode/logs`
  if (logDir.startsWith('~/')) logDir = env.home + logDir.slice(1)
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const envKeep = env.keep ? Number(env.keep) : NaN
  return {
    features: parseFeatures(env.features ?? (typeof o.features === 'string' ? o.features : 'all')),
    compactionAuto: o.compaction_auto !== false,
    compactionPrune: env.prune ? env.prune === '1' : o.compaction_prune === true,
    keepTokens: Number.isFinite(envKeep) ? envKeep : num(o.keep_tokens, 15_000),
    compactionBuffer: num(o.compaction_buffer, 0),
    compactionTail: o.compaction_tail === 'messages' ? 'messages' : 'text',
    logDir,
    panel: o.panel === true,
  }
}
