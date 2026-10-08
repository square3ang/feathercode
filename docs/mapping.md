# OpenCode v2 → Claude Code Mod mapping

Source: OpenCode branch `v2` (commit `0d07f91`, packages 2.0.24, MIT).
Target: Claude Code Mods API as typed by Claude Code **2.1.293** (cloud session).
Local version: _to fill in at the final local check_.

Legend: ✅ possible · ◐ partial · ❌ not possible with the Mod API

| OpenCode v2 part | What it does | Mod event / API | Status | Notes |
|---|---|---|---|---|
| **System block 0**: `runner/prompt/system.txt` + tool guidance + `anthropic.txt` (~1.8k chars) | short fixed harness prompt | `prompt.compose`: replace the engine's own sections with one `shared` section | ✅ | Plugin sections from other mods (`<plugin>:<id>`) are kept, so `next(e)` is called and only the engine's bare-id sections are replaced. One line of Claude Code's security policy is kept. |
| **System block 1**: `# Your Model` identity | model name/id | Claude Code's own `model` attachment (first user message) | ✅ (engine) | Already in the frozen first message; nothing to add. |
| **System block 2**: instruction baseline, frozen per epoch (skills, AGENTS.md, date, env) | variable context kept out of block 0 | Claude Code already puts these in the **first user message** (`prompt.context` blocks + `environment`/`date`/`skill_listing` attachments), which is equally frozen | ◐ | Same cache shape as v2. The engine's `environment` attachment is kept (the v2 template carries the same facts and came out longer); `skill_listing` descriptions are cut to their first sentence; `userEmail` and `session_context` (git status) dropped (v2 has neither). |
| Instruction deltas (date rollover, AGENTS.md edits) appended as `system` messages at the tail | keep the prefix stable | engine's own `date_change` / `nested_memory` style attachments are appended rows already | ✅ (engine) | Nothing to do; the cache stays stable. |
| AGENTS.md discovery (AGENTS.md only, global + ancestors) | project instructions | built-in mod `cc-plugin-agents-md` (AGENTS.md) + engine `claudeMd` (CLAUDE.md) | ◐ | CLAUDE.md is kept (dropping a user's own instructions is unsafe). The plugin does not load AGENTS.md itself, so nothing is duplicated. |
| Nested AGENTS.md after a read, as a persisted user message | | engine's `nested_memory` attachment | ✅ (engine) | |
| **Cache policy** (`ai/cache-policy.ts`): tools(last) + system first&last + tail(1) = 4 markers, 5-minute TTL | prompt cache | engine places markers; Mods only pick section `scope` | ◐ | Ported as "the prefix never changes": one `shared` section, no per-request edits of earlier content, stable `tool.describe` / `prompt.attachment` answers (cached per process anyway). Claude Code requests a 1h TTL, which is better than v2's 5 minutes. |
| v2 cache warming (opt-in keep-alive) | keeps the 5-minute cache | — | not needed | Claude Code's 1h TTL covers it. |
| `toolChoice:"none"` with tools kept on the max-steps step | keeps the prefix | `turn.step` can change only model/effort | ❌ | v2 has no default `steps`, so nothing is lost by default. |
| MAX_STEPS_PROMPT (trailing assistant message) | step cap | `turn.step` can't add messages | ❌ | Only active in v2 when `agent.steps` is configured (no default). |
| **Tools**: read, edit, write, glob, grep, shell, skill, subagent, question, webfetch, websearch | | built-ins Read, Edit, Write, Glob*, Grep*, Bash, Skill, Agent, AskUserQuestion, WebFetch, WebSearch | ✅ | `tool.describe` rewrites descriptions to v2 wording, adapted to Claude Code parameter names. Schemas can't be changed. *Glob/Grep are not registered by the native Linux/macOS build; Bash with `rg`/`find` covers them. |
| v2 `execute` (Code Mode) and `opencode.*` tools | MCP/tool catalog via JS | — | ❌ (skipped) | Claude Code's ToolSearch fills the same role (deferred tools). |
| Heavy Claude Code tools (Workflow, ScheduleWakeup, Monitor, Cron*, worktree, notifications, ...) | not in OpenCode | `tool.describe` → `isDeferred: true` | ✅ | Still callable through ToolSearch. A tool can't be deleted, only deferred. |
| TodoWrite / Task* | v2 has no todo tool | defer | ✅ | |
| **Agents** build / plan (primary) | same prompt + tools, plan denies edits except the plan dir | own `/build` `/plan` commands, `tool.check` deny, `$.session.append` for the switch reminder | ✅ | Claude Code's built-in plan mode is not used (it blocks in `-p` on ExitPlanMode's approval dialog and has its own reminder text). |
| Plan enter/leave reminder, persisted once per switch | | `$.session.append({type:'user'})`, appended at the tail | ✅ | Same shape as v2: one persisted message, the prefix untouched. |
| Plan reconcile after compaction | re-inject if lost | the compaction result includes the current mode reminder | ✅ | |
| Mode display | TUI | `ui.render` AbovePrompt (where a UI exists), else command text | ✅ | `$.session.surfaces()` decides. |
| Subagents general / explore | | `$.agent.register` (`feathercode:general`, `feathercode:explore`) + `agent.offer` hides `general-purpose`, `Explore`, `Plan`, `claude` | ✅ | |
| title / summary agents | session titles | — | not needed | Claude Code titles sessions itself. |
| **Compaction** (`session/compaction.ts`) | summary + recent text checkpoint | `session.compact` answered without `next` | ✅ | |
| ↳ summary request reuses the session's own system/tools/messages (cache-warm) | | `$.model.fork({ prompt })` | ✅ | Same prefix reuse. For a subagent's loop (`agentId`) fork isn't possible: `$.model.complete` on the flattened text (v2's own over-budget path). |
| ↳ keep newest 15k tokens as flattened text in `<recent-context>` | | built into the returned `{ messages }` (one user message, no handle) | ✅ | Option to keep the recent messages verbatim (with handles) instead. |
| ↳ trigger `estimate >= window - max(10%, 16k)` | | `session.measure` → `$.session.compact()` between turns, on max(measured context, last request's input+cache+output); the engine's own `auto` trigger also goes through the hook | ◐ | A mid-turn trigger before each step isn't possible (`turn.step` can't compact). The engine's own threshold covers mid-turn overflow and still uses the v2 summary. |
| ↳ overflow retry (shrink 70/50/35%) | | engine handles API overflow | ◐ | |
| ↳ precompute | | `trigger: 'precompute'` → skip | ✅ | v2 doesn't precompute. |
| Prune (v1 only, removed in v2) | clear old tool output | `session.compact` with `trigger:'plugin'` from `turn.complete` | ✅ (option, off) | Kept as an option because it was asked for; off by default like OpenCode v1. |
| Config `compaction.auto`, `compaction.keep.tokens`, `compaction.buffer` | | `userConfig` | ✅ | v2 rejects `prune`/`tail_turns`; `keep_tokens` replaces `tail_turns`. |

## Facts about Claude Code found while mapping

- The hooks module validator only follows `$` into functions in the same file: every hook and `$` call lives in `hooks/register.ts`; `hooks/lib/` is pure logic.
- One hook per event (without a matcher) per module.
- In `claude -p` started from inside a cloud session, the child inherits the parent's session id and remote settings; the bench runner strips the environment and uses its own `CLAUDE_CONFIG_DIR`.
- In this container `-p` runs get the **lean** system prompt (`lean_body`, ~6.3k chars total), the full prompt is used interactively. Cloud and local numbers differ for that reason.
- Claude Code caches with a **1h TTL** (`ephemeral_1h_input_tokens`).
