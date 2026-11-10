/**
 * Which built-in tools stay in the prompt's tool list and which wait behind
 * ToolSearch. OpenCode's model sees a small fixed set (shell, read, edit,
 * write, glob, grep, subagent, todo, webfetch, websearch, skill, question);
 * the Claude Code equivalents of those stay listed, every other built-in
 * (including ones a newer build adds) is deferred: still callable, its schema
 * loaded by name when the model asks.
 */

/** Kept in the listed set (OpenCode's own set, by Claude Code name). */
export const KEEP_LISTED: ReadonlySet<string> = new Set([
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Agent',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'WebFetch',
  'WebSearch',
  'Skill',
  'AskUserQuestion',
  'ToolSearch',
])

/** Tools a pinned list keeps in front even when ToolSearch would load them. */
export type ToolPolicy = { pin: ReadonlySet<string> }

/**
 * The deferral decision for one built-in: true to defer it, false to list it,
 * undefined to leave the engine's choice.
 */
export function deferralFor(tool: string, engineDeferred: boolean, policy: ToolPolicy): boolean | undefined {
  if (policy.pin.has(tool)) return false
  if (KEEP_LISTED.has(tool) || engineDeferred) return undefined
  return true
}
