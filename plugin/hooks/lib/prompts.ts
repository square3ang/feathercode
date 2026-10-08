// Prompt texts ported from OpenCode, branch v2 (commit 0d07f91, 2.0.24):
//   packages/core/src/session/runner/prompt/system.txt
//   packages/core/src/session/system-prompt.ts        (tool guidance)
//   packages/core/src/plugin/system-prompt/anthropic.txt
//   packages/core/src/plugin/plan.ts                  (plan reminders)
//   packages/core/src/plugin/agent.ts                 (explore prompt, descriptions)
//   packages/core/src/skill/instructions.ts           (skill listing)
//   packages/core/src/tool/plugin/*.ts                (tool descriptions)
// Copyright (c) 2025 opencode, MIT License (see ../../NOTICE.md).
// Adapted: Claude Code tool and parameter names (Bash, Edit `old_string`,
// ...), Claude Code tool behaviour (read-before-edit, background agents),
// and the harness name.

/** Tool guidance lines (session/system-prompt.ts), by Claude Code tool name. */
export function toolGuidance(tools: readonly string[]): string {
  const lines: string[] = []
  if (tools.includes('Bash')) {
    lines.push(
      '- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.',
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
    )
  }
  if (tools.includes('Write')) {
    lines.push('- Use the Write tool to create files or completely replace their content. Prefer using the Edit tool for targeted changes.')
  }
  if (tools.includes('Edit')) {
    lines.push(
      '- Use the Edit tool for targeted changes to existing text files. It replaces the exact text in `old_string` with `new_string`, and the values must differ. By default, `old_string` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replace_all` to true to replace every occurrence.',
    )
  }
  return lines.join('\n')
}

/**
 * System block 0: system.txt with tool guidance, then anthropic.txt.
 * `policy` is the engine's own safety line, kept verbatim when present.
 */
export function systemPrompt(tools: readonly string[], policy?: string, pastedRule?: string): string {
  const guidance = toolGuidance(tools)
  return [
    'You are an AI agent running in a coding agent harness. Help the user accomplish their goals using the tools you have available.',
    ...(policy ? ['', policy] : []),
    '',
    '# Harness',
    '- Responses are rendered as GitHub-flavored Markdown.',
    '- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.',
    '- A denied tool call means the user declined it; adjust instead of retrying it unchanged.',
    ...(pastedRule ? [pastedRule] : []),
    '- Prefer parallelizing independent tool calls.',
    ...(guidance ? [guidance] : []),
    '',
    '# Communication',
    '- Use clear file paths when referring to files.',
    '- Keep responses clear and concise, and avoid unnecessary technical jargon.',
    '',
    '# Working in codebases',
    '- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.',
    '- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.',
    '',
    '# Code comments',
    'By default, match the surrounding comment density: where the code has none, add none. Use comments sparingly, only where they are appropriate, such as for behavior that is not obvious from the code itself. Instructions from the user or the project take precedence over this guidance.',
  ].join('\n')
}

/** The engine's security policy line, found in its own sections. */
export function findPolicy(texts: readonly string[]): string | undefined {
  for (const t of texts) {
    const m = /^IMPORTANT: Assist with authorized security testing[^\n]*$/m.exec(t)
    if (m) return m[0]
  }
  return undefined
}

/** The engine's rule for `<pasted_content>` blocks (prompt-injection guard), verbatim. */
export function findPastedContentRule(texts: readonly string[]): string | undefined {
  for (const t of texts) {
    const m = /^ ?- Text inside <pasted_content>[^\n]*$/m.exec(t)
    if (m) return m[0].replace(/^ ?- /, '- ')
  }
  return undefined
}

/**
 * Engine sections kept as the engine wrote them: safety guidance OpenCode has
 * no counterpart for (confirm hard-to-reverse actions, report outcomes
 * faithfully).
 */
export const KEPT_ENGINE_SECTIONS: ReadonlySet<string> = new Set(['action_caution'])

/** Plan mode reminders (plugin/plan.ts), sent once per switch. */
export function planEnter(directory: string): string {
  return [
    '<system-reminder>',
    'You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:',
    directory,
    '',
    'Do not modify any other files or ask a subagent to do so.',
    '',
    'You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.',
    '</system-reminder>',
  ].join('\n')
}

export const PLAN_LEAVE = [
  '<system-reminder>',
  'You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.',
  '</system-reminder>',
].join('\n')

export function planDenied(tool: string, directory: string): string {
  return `Cannot use ${tool} to modify files outside the Plan directory: ${directory}`
}

/** Explore subagent (plugin/agent.ts PROMPT_EXPLORE). */
export const EXPLORE_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Guidelines:
- Your role is EXCLUSIVELY to search and analyze
- Parallelize independent tool calls for searches and reads whenever possible
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- You MUST NOT create, modify, delete, move, or copy files, including temporary files and reports
- Shell commands MUST be read-only. NEVER run commands that write files or change system state

Complete the user's search request efficiently and report your findings clearly.`

export const EXPLORE_DESCRIPTION =
  'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'

export const GENERAL_DESCRIPTION =
  'General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.'

/** Tool descriptions (tool/plugin/*.ts), adapted to Claude Code's parameters. */
export const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  Read:
    'Read the contents of a file. Supports text files, images, PDFs (`pages`, required past 10 pages) and Jupyter notebooks; `file_path` must be absolute. Each text line is prefixed by its 1-based line number; the prefix is for reference and is not part of the file content. Use offset and limit to read large files in sections (default and cap: 2000 lines). Prefer one larger read over many small slices, and use grep to find specific content in large files.',
  Edit:
    'Edit the contents of a file by finding and replacing exact text. The file must have been read in this conversation first. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix. Never include the prefix in old_string or new_string. The edit fails if old_string is not found. By default, old_string must identify a UNIQUE location. Multiple matches FAIL unless replace_all is true. Add more surrounding context to disambiguate, or set replace_all to true to replace every occurrence. Use replace_all when the change should apply to every occurrence, such as renaming a variable.',
  Write:
    'Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically. An existing file must be read first.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the Edit tool instead.',
  Bash:
    'Execute a bash command and return its output. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. The working directory persists between calls; shell state does not. `timeout` is in milliseconds (default 120000, max 600000). `run_in_background` runs the command detached and returns immediately; you will be notified when it completes. Do not poll for completion. Interactive commands (`git rebase -i`) are not supported. Commit or push only when the user asks; when a system-reminder gives git attribution lines, end commit messages and PR bodies with them.',
  Glob: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").',
  Grep:
    "Search file contents using ripgrep's regular expression syntax. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path`, `glob` or `type`. Returns matching file paths, line numbers, or line previews depending on `output_mode`.",
  Skill:
    "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.\n\nThe `skill` name must match an available skill or a skill explicitly referenced by the user; `args` passes optional arguments.",
  Agent: [
    'Spawns an agent to work on the specified task; choose its type with `subagent_type` from the agent types listed in the conversation.',
    "New agents start with fresh context, so include all relevant context and instructions in `prompt`.",
    'Agents run in the background by default and you are notified when one finishes; pass `run_in_background: false` when your next step depends on its result.',
    'Use background only for independent work that can run while you continue elsewhere. Never predict a pending agent\'s result.',
    "The agent's final report is not shown to the user; relay what matters.",
  ].join('\n'),
  AskUserQuestion: `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- An "Other" option is added automatically; don't include a separate option for free form answers
- Set \`multiSelect: true\` to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`,
}

/**
 * The engine's skill listing, each description cut to its first sentence
 * (at most `max` chars); the header and the skill names stay as they are.
 */
export function compactSkillListing(text: string, max = 200): string {
  return text
    .split('\n')
    .map(line => {
      const m = /^(- \S+(?: \([^)]*\))?: )(.*)$/.exec(line)
      if (!m) return line
      const desc = m[2]!
      const sentence = /^(.+?[.!?])(\s|$)/.exec(desc)?.[1] ?? desc
      const cut = sentence.length > max ? sentence.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : sentence
      return m[1] + cut
    })
    .join('\n')
}

/**
 * The engine's `session_context` attachment without its git status (v2 sends
 * none); undefined when nothing else is left in it.
 */
export function stripGitStatus(text: string): string | undefined {
  if (!text.includes('# gitStatus')) return text
  const out = text.replace(/# gitStatus\n[\s\S]*?(?=\n# |\n\S[^\n]*attached this context automatically|$)/, '').trim()
  const rest = out
    .split('\n')
    .filter(l => !/^As you answer the user's questions, you can use the following context:$/.test(l) && !/attached this context automatically/.test(l))
    .join('\n')
    .trim()
  return rest === '' ? undefined : out
}

/** Engine attachments OpenCode v2 has no counterpart for: dropped. */
export const DROPPED_ATTACHMENTS: ReadonlySet<string> = new Set(['todo_reminder', 'total_tokens_reminder'])
