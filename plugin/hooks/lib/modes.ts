// Build / plan agents, as OpenCode v2 defines them (plugin/plan.ts):
// plan denies the edit permission (edit, write, patch) except in the plan
// directory (Claude Code's Edit, Write, NotebookEdit); the shell and
// subagents are not restricted.
// Copyright (c) 2025 opencode, MIT License (see ../../NOTICE.md).

export type Mode = 'build' | 'plan'

/**
 * The plan directory, under the project root (OpenCode v1's `.opencode/plans`
 * placement; v2 uses `~/.opencode/plan`, which would need the home directory).
 */
export function planDir(root: string): string {
  return `${root.replace(/[\\/]$/, '')}/.opencode/plan`
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

/** Whether `path` lies inside `dir` (both lexically normalised, absolute). */
export function isInside(path: string, dir: string): boolean {
  const target = normalize(path)
  const root = normalize(dir)
  return target !== undefined && root !== undefined && target.startsWith(root + '/')
}
