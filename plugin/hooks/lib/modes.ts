// Build / plan agents, as OpenCode v2 defines them (plugin/plan.ts):
// plan denies the edit permission (edit, write, patch) except in the plan
// directory; the shell and subagents are not restricted.
// Copyright (c) 2025 opencode, MIT License (see ../../NOTICE.md).

export type Mode = 'build' | 'plan'

/** Claude Code's edit-permission tools and the input field naming the file. */
export const EDIT_TOOLS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}

export function planDir(home: string): string {
  return `${home.replace(/[\\/]$/, '')}/.opencode/plan`
}

/** Lexically normalised absolute path (`.`/`..` resolved), or undefined. */
export function normalize(path: string): string | undefined {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) return undefined
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const parts: string[] = []
  for (const p of path.split(/[\\/]+/)) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return path.startsWith('/') ? '/' + parts.join('/') : parts.join(sep)
}

/** Whether `tool` with `input` may run in plan mode. */
export function planAllows(tool: string, input: unknown, dir: string): boolean {
  const field = EDIT_TOOLS[tool]
  if (!field) return true
  const raw = (input as Record<string, unknown> | null)?.[field]
  if (typeof raw !== 'string') return false
  const target = normalize(raw)
  const root = normalize(dir)
  return target !== undefined && root !== undefined && target.startsWith(root + '/')
}
