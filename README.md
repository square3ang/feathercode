# feathercode

OpenCode's harness (branch `dev`, 2.2.7) ported to a Claude Code **mod**: a short
fixed system prompt, a cache-stable context, OpenCode's tool set and
compaction, build/plan agents, and per-request token/cache instrumentation.
Personal, interactive use; the aim is lower token overhead and better prompt
cache reuse, so a plan's usage limit lasts longer.

Not affiliated with Anthropic or the OpenCode authors. Ports OpenCode's
prompts and algorithms under the MIT License (see `NOTICE.md`).

## Install

From a checkout, for one session:

```sh
claude --plugin-dir /path/to/feathercode/plugin
```

From GitHub, in a Claude Code terminal session:

```
/plugin install feathercode --marketplace square3ang/feathercode
```

Answer `y` to add the marketplace, then pick a scope.

## What it changes

| Area | Claude Code default | feathercode |
|---|---|---|
| System prompt | Claude Code's sections (lean ≈ 6.3k chars in `-p`, more interactively) | OpenCode dev `system.txt` + tool guidance + `anthropic.txt`, verbatim except "OpenCode" → "FeatherCode" (≈ 2k chars), one `shared` (cross-session cached) section; other mods' sections are kept |
| First-message context | CLAUDE.md, email, date, git status, skill listing, ... | CLAUDE.md, date, environment; no email or git status; skill descriptions cut to their first sentence |
| Reminders | todo and token-count reminders | dropped |
| Tools | every built-in listed that the build does not defer (Artifact*, Workflow, ScheduleWakeup, ...) | OpenCode's set listed (Bash, Read, Edit, Write, Glob/Grep, Agent, TodoWrite/TaskCreate/TaskUpdate, WebFetch, WebSearch, Skill, AskUserQuestion, ToolSearch), several with OpenCode descriptions; every other built-in behind ToolSearch, still callable |
| Agents | Explore, general-purpose, Plan, ... | `feathercode:explore`, `feathercode:general` (OpenCode prompts); the overlapping built-ins hidden |
| Modes | Claude Code plan mode | `/fc-plan` and `/fc-build` (OpenCode plan agent): plan denies Edit/Write/NotebookEdit outside `<project>/.opencode/plan`, one reminder per switch appended at the end |
| Compaction | Claude Code's summary | Claude Code decides when (its own auto threshold, `/compact`); OpenCode dev decides how: same-prefix summary (`$.model.fork`, cache-warm), its template, newest 15k tokens kept in a `<conversation-checkpoint>`; when the fork fails, dev's text fallback (exchanges shortened oldest first to fit) |
| Prune | — | OpenCode v1 prune as an option (off) |
| Band above the prompt | — | one flat row in the terminal and the desktop app: `● build`/`● plan` (click to switch), context %, cache hit %, requests and tokens, cache breaks; `Stats` and `Plan`/`Build` buttons at the right |

Every change keeps the start of the request fixed for the whole session:
nothing earlier in the conversation is rewritten (except by compaction or
prune, which OpenCode does as well).

## Commands

| Command | |
|---|---|
| `/feathercode-stats` | requests, input/output, cache read/write, hit %, cache breaks with candidate causes, prompt and tool sizes (plain text, works in `-p`) |
| `/feathercode-panel` | the same in a pane (falls back to text where no UI exists) |
| `/fc-plan`, `/fc-build` | switch agents (`/plan` is Claude Code's own) |
| `/compact [focus]` | Claude Code's command, answered by the OpenCode compaction |

## Options (`/config`, or `pluginConfigs` in settings)

| Option | Default | |
|---|---|---|
| `features` | `all` | comma list of `prompt,cache,tools,modes,agents,compact`, or `observe` (instrumentation only) |
| `compaction_auto` | `true` | OpenCode `compaction.auto`: off skips Claude Code's automatic compaction |
| `keep_tokens` | `15000` | OpenCode `compaction.keep.tokens` |
| `compaction_tail` | `text` | `text` (OpenCode: recent part flattened into the checkpoint) or `messages` (kept verbatim) |
| `compaction_prune` | `false` | OpenCode v1 prune (removed in current OpenCode) |
| `panel` | `false` | open the stats pane at start |

Logs: `<plugin folder>/logs/<session id>.jsonl`. The bench passes options with
`claude --settings '{"pluginConfigs":{"feathercode@inline":{"options":{...}}}}'`.
What each hook decides, the one file written and the one command run are
listed in `plugin/README.md`.

## Measuring

```sh
python3 bench/run.py --label baseline --features observe
python3 bench/run.py --label all --features all
python3 bench/analyze.py bench/results/baseline bench/results/all
python3 bench/analyze.py plugin/logs/<session>.jsonl
python3 bench/live.py plan compact prune
```

Results so far: `bench/results/REPORT.md`. Docs: `docs/mapping.md`
(OpenCode → Mod mapping), `docs/report.md` (stage results, remaining cache
breaks, differences from OpenCode), `docs/local-checklist.md`.

## Layout

```
plugin/                 the mod
  hooks/register.tsx    every hook and $ call (the engine requires one file)
  hooks/lib/            pure logic: prompts, compaction, prune, stats, tools
  tests/                claude plugin test
bench/                  task set, runner, analyzer, live scenarios, results
docs/
```
