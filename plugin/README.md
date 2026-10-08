# feathercode

OpenCode's harness (branch `v2`) as a Claude Code mod: a short fixed system
prompt, a cache-stable context, OpenCode's tool set and compaction,
build/plan agents, and token/cache instrumentation. Ports OpenCode's prompts
and algorithms under the MIT License (`NOTICE.md`). Not affiliated with
Anthropic or the OpenCode authors.

## Install

```
/plugin install feathercode --marketplace square3ang/feathercode
```

or for one session from a checkout: `claude --plugin-dir <path>/plugin`.

## Commands

| Command | What it does |
|---|---|
| `/feathercode-stats` | prints requests, input/output, cache read/write, hit %, cache breaks with candidate causes, prompt and tool sizes |
| `/feathercode-panel` | the same in a pane; prints the text where no UI is attached |
| `/plan` | switches to the plan agent (read-only; see `tool.check` below) |
| `/build` | switches back to the build agent (the default) |

If `/plan` or `/build` is already taken, they register as `/fc-plan` and
`/fc-build`.

## Options (`/config`)

| Option | Default | |
|---|---|---|
| `features` | `all` | comma list of `prompt,cache,tools,modes,agents,compact`, or `observe` (instrumentation only) |
| `compaction_auto` | `true` | compact automatically at OpenCode's threshold |
| `keep_tokens` | `15000` | newest conversation kept verbatim when compacting |
| `compaction_buffer` | `0` | compact at window − buffer; 0 = window − max(10%, 16k) |
| `compaction_tail` | `text` | `text`: recent part flattened into the checkpoint; `messages`: kept verbatim |
| `compaction_prune` | `false` | clear old tool outputs after a turn (OpenCode v1 prune) |
| `panel` | `false` | open the stats pane at start |

## Hooks that decide something

Every hook below is in `hooks/register.tsx`. None of them ever answers
**allow** to a permission question: permission decisions stay with the user,
their settings and the permission mode.

| Hook | What it decides | When |
|---|---|---|
| `tool.check` | **denies** Edit, Write and NotebookEdit whose `file_path` / `notebook_path` is outside `<project root>/.opencode/plan`, with the reason `Cannot use <tool> to modify files outside the Plan directory: <dir>` | only in plan mode (after `/plan`, until `/build`), feature `modes` on. For every other tool, in build mode, and for a path inside the plan directory, it returns Claude Code's own verdict unchanged. If the hook fails, its `.catch` denies those three edit tools and returns Claude Code's verdict for everything else. |
| `agent.offer` | hides the built-in agent types `Explore`, `general-purpose`, `Plan` and `claude` from the model | only once `feathercode:explore` and `feathercode:general` registered (feature `agents`); they replace them. Other agent types are offered as usual. |
| `session.compact` | answers compaction with OpenCode v2's summary (`<conversation-checkpoint>` + the newest `keep_tokens` of conversation) instead of Claude Code's; skips `precompute` (ahead-of-time) compaction; with `compaction_auto` off, skips automatic compaction; with `compaction_prune` on, answers the prune request by replacing old tool outputs with `[Old tool result content cleared]` | every compaction of the main conversation (`/compact`, automatic, the mod's own trigger), feature `compact` on. A subagent's compaction is left to Claude Code. |
| `tool.call` | nothing: counts the call for the stats and passes it on unchanged | every tool call |
| `command.run` | answers the mod's own commands above | when you run them |
| `prompt.compose` | replaces Claude Code's own system prompt sections with one OpenCode section (keeps Claude Code's one-line security policy and every other mod's sections) | every system prompt render, feature `prompt` on, no output style selected |
| `prompt.context` | leaves out the `userEmail` block | the first message's context, feature `prompt` on |
| `prompt.attachment` | leaves out the todo and token-count reminders and the git status; shortens each skill description to its first sentence | as Claude Code injects them, feature `cache` on; text from settings hooks and other mods passes untouched |
| `tool.describe` | rewrites the descriptions of Bash, Read, Edit, Write, Glob, Grep, Skill, Agent and AskUserQuestion to OpenCode's wording; moves heavy tools (Workflow, ScheduleWakeup, Monitor, Cron*, worktree, notification tools, ...) behind ToolSearch, where they stay callable | once per tool per session, feature `tools` on; tools of MCP servers and other plugins untouched |

## Calls that act outside the conversation

- **Files written**: only the mod's own log,
  `<plugin folder>/logs/<session id>.jsonl` (`<session id>.<n>.jsonl` past
  3.5 MB), by `$.fs.write` in `flush()`. It is read back by `$.fs.read` in
  `loadCtx()` when a session resumes. The mod does not create or edit any
  build, start-up, settings or instructions file. In plan mode the *model*
  may write plan files under `<project root>/.opencode/plan` with its own
  Write tool, through the normal permission check.
- **Commands run**: one, `/compact`, through `$.command.run`, only when the
  session runs headless (`claude -p`, the SDK) and Claude Code refuses
  `$.session.compact()` between turns there. It is queued after a turn in which
  the context reached the compaction threshold (`compaction_auto`), or, with
  `compaction_prune` on, when old tool outputs would free more than 20k
  tokens. Interactive sessions call `$.session.compact()` directly instead.
- **Model calls**: `$.model.fork` (and, when nothing can be forked yet,
  `$.model.complete` with the session's model) to write the compaction
  summary of the conversation, on the session's own Claude client.
- **Conversation rows**: `$.session.append` adds one reminder message when you
  switch between `/plan` and `/build`.
- **Stored values**: `$.store` keeps the current mode per session id, so
  `--continue` / `--resume` restore it.
- **What the log holds**: per request, token counts (input, output, cache
  read/write), model, tool names, attachment types and sizes, system prompt
  section ids and sizes, and compaction counts. No conversation text, no file
  contents, no paths, names or emails. It stays in the plugin folder and is
  sent nowhere.
- **No credentials, no environment variables and no network calls** of the
  mod's own: it reads nothing from the environment and sends nothing anywhere
  but the session's own model requests.

## Files

```
.claude-plugin/plugin.json   manifest and options
.claude-plugin/icon.png      icon
hooks/register.tsx           every hook and every $ call
hooks/lib/                   pure logic: prompts, compaction, prune, stats, tools, modes
tests/                       claude plugin test
logs/                        written at run time (session logs)
```
