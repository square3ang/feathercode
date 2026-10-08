/**
 * Which built-in tools stay in the prompt's tool list and which wait behind
 * ToolSearch. OpenCode's model sees a small fixed set (bash, read, edit,
 * write, glob, grep, task, todowrite, webfetch, websearch, skill, question);
 * the light Claude Code equivalents of those stay listed, everything heavier
 * (background, orchestration, worktree, notification, scheduling) is deferred:
 * still callable, its schema loaded by name when the model asks.
 *
 * A tool deferred here and later loaded by ToolSearch adds its schema to the
 * request; bench measures whether that breaks the cache (stage 2).
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
  'WebFetch',
  'WebSearch',
  'Skill',
  'AskUserQuestion',
  'ToolSearch',
])

/** Built-ins moved behind ToolSearch. */
export const DEFER: ReadonlySet<string> = new Set([
  'Workflow',
  'ScheduleWakeup',
  'ListAgents',
  'ReportFindings',
  'Monitor',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
  'SendMessage',
  'PushNotification',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'NotebookEdit',
  'TaskStop',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'EnterPlanMode',
  'ExitPlanMode',
  'LSP',
  'SendUserMessage',
  'SendUserFile',
  'SendFile',
  'ListConnectors',
  'ListPlugins',
  'ListSkills',
  'SearchPlugins',
  'SearchSkills',
  'SearchMcpRegistry',
  'SuggestConnectors',
  'SuggestPluginInstall',
  'SuggestSkills',
  'ReadMcpResourceTool',
  'ListMcpResourcesTool',
  'ReadMcpResourceDirTool',
  'WaitForMcpServers',
  'Poll',
  'GetTask',
  'FetchInboxMessage',
  'ReadNotifications',
  'EndConversation',
  'ProposeGoal',
])

/** Tools a pinned list keeps in front even when ToolSearch would load them. */
export type ToolPolicy = { pin: ReadonlySet<string> }

/**
 * The deferral decision for one tool: true/false to move it, undefined to
 * leave the engine's choice. `pin` names deferred tools measured to break the
 * cache when loaded (stage 2), which then stay listed.
 */
export function deferralFor(tool: string, engineDeferred: boolean, policy: ToolPolicy): boolean | undefined {
  if (policy.pin.has(tool)) return false
  if (KEEP_LISTED.has(tool)) return undefined // never deferred by us; the engine's own choice stands
  if (DEFER.has(tool)) return engineDeferred ? undefined : true
  return undefined
}
