/**
 * JSONL logger. $.fs has no append, so the session's lines are held in memory
 * and the whole file is rewritten on each flush (writes are chained). One file
 * per session id; a reload re-reads what is already there. Past MAX_BYTES the
 * log rolls to `<id>.<n>.jsonl`.
 */
const MAX_BYTES = 3_500_000

export type JsonlLog = {
  lines: string[]
  path?: string
  base: string
  writing: Promise<void>
  dirty: boolean
  bytes: number
  part: number
}

export function createLog(): JsonlLog {
  return { lines: [], base: '', writing: Promise.resolve(), dirty: false, bytes: 0, part: 0 }
}

export function writeLog(log: JsonlLog, record: Record<string, unknown>): void {
  const line = JSON.stringify(record)
  log.lines.push(line)
  log.bytes += line.length + 1
  log.dirty = true
}

/** The path of the next write and its text; rolls the log past MAX_BYTES. */
export function takeFlush(log: JsonlLog): { path: string; text: string } | undefined {
  if (!log.path || !log.dirty) return undefined
  log.dirty = false
  const path = log.path
  const text = log.lines.join('\n') + '\n'
  if (log.bytes > MAX_BYTES) {
    log.part += 1
    log.path = `${log.base}.${log.part}.jsonl`
    log.lines = []
    log.bytes = 0
  }
  return { path, text }
}

/** Sets the file for a session and merges lines already written there. */
export function attachLog(log: JsonlLog, dir: string, sessionId: string, existing: string | undefined): void {
  log.base = `${dir.replace(/[\\/]$/, '')}/${sessionId}`
  log.path = `${log.base}.jsonl`
  if (existing && existing.length > 0) {
    log.lines = existing
      .split('\n')
      .filter(l => l.length > 0)
      .concat(log.lines)
    log.bytes = existing.length
  }
}
