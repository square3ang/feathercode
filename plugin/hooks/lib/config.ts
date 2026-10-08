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

/** The userConfig values, defaults filled in. */
export function resolveConfig(o: Record<string, unknown>): Config {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    features: parseFeatures(typeof o.features === 'string' ? o.features : 'all'),
    compactionAuto: o.compaction_auto !== false,
    compactionPrune: o.compaction_prune === true,
    keepTokens: num(o.keep_tokens, 15_000),
    compactionBuffer: num(o.compaction_buffer, 0),
    compactionTail: o.compaction_tail === 'messages' ? 'messages' : 'text',
    panel: o.panel === true,
  }
}
