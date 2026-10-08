# feathercode — report

OpenCode **v2** (branch `v2`, commit `0d07f91`, 2.0.24) ported to a Claude
Code mod. Measured in a Claude Code cloud session with Claude Code
**2.1.293**, `claude -p`, model sonnet (`claude-sonnet-5-5`), one run per
task. Raw numbers: `bench/results/REPORT.md`; per-run JSONL logs beside it.

## 1. Effect by stage (cumulative)

Four tasks: tomli explain (read/locate), tomli injected-bug fix, more-itertools
feature, kleur multi-file feature. "weighted" = input + 2×cache write (1h TTL)
+ 0.1×cache read + 5×output (API-price-equivalent input tokens, a proxy for
plan usage); `$` is Claude Code's own `total_cost_usd`.

| stage | features | pass | first request (avg tokens) | cache write | cache read | weighted | Δ weighted | $ |
|---|---|---|---|---|---|---|---|---|
| baseline | observe only | 4/4 | 16,254 | 33,947 | 249,343 | 113,695 | — | 0.227 |
| 1 | + system prompt | 4/4 | 14,907 | 37,487 | 206,521 | 114,951 | +1.1% | 0.230 |
| 2 | + context/attachments | 4/4 | 13,396 | 22,135 | 250,633 | 95,009 | −16.4% | 0.190 |
| 3 | + tools | 4/4 | 7,333 | 22,952 | 112,958 | 78,654 | −30.8% | 0.157 |
| 4 | + build/plan, agents | 4/4 | 7,144 | 20,988 | 127,961 | 74,966 | −34.1% | 0.150 |
| 5 (= all) | + compaction | 4/4 | 7,144 | 21,488 | 120,015 | 76,249 | −32.9% | 0.152 |

- **Success rate never dropped** (4/4 at every stage), so no stage was reverted.
- Stage 1 is small in the cloud because `-p` here already gets Claude Code's
  short "lean" prompt (6.3k chars → 2.3k). Interactive sessions use the full
  prompt, so the local saving should be larger. Its write figure is inflated by
  the first task writing the new prefix cold (18.6k); the following tasks read
  it from the cross-session cache.
- Stage 3 is the big one: listed tool descriptions 14.9k → 3.8k chars, and
  their schemas leave the prefix with them.
- Cache hit % goes down slightly from stage 3 on: the prefix that used to be
  read from cache is simply gone. Total volume is what costs.
- n = 1 per task: single-run noise (e.g. `mit-count-runs` takes 22–78 s
  depending on how often the model runs the test suite) is large next to
  stage-to-stage differences of a few %. Stage 3/4 vs baseline is well
  outside it.

## 2. Cache breaks

No cache break in any bench run or live scenario (the detector flags any
request whose cache read falls short of the previous request's prompt by
more than 1,024 tokens, per loop).

| tested | result |
|---|---|
| Deferred tool loaded with ToolSearch (NotebookEdit, Workflow) mid-session | no break: the next request read the whole previous prefix (7,308 → 7,411); Claude Code loads deferred schemas without touching the prefix. So no tool needs to stay pinned. |
| `/plan` → `/build` switches | no break: the reminder is one appended message (v2 style) |
| `--continue` across processes | no break; the shared system section is also read across sessions |
| Late `deferred_tools_delta` (tools feathercode defers are announced one step later) | appended at the tail: no break |

Remaining break causes the mod can't remove (by design or by API):

- **Compaction / prune**: rewrite history; a full re-write follows (same as OpenCode).
- **Idle past the cache TTL** (Claude Code requests 1h; OpenCode v2 uses 5 min + optional keep-alive).
- **Model or effort change mid-session** (`/model`, `/effort`): a new cache.
- **Mods/settings changing a cached answer mid-session** (`$.ui.invalidate`): feathercode never invalidates.
- **CLAUDE.md edits**: picked up after compaction or `/clear` only, as v2 does with its epoch.

## 3. Compaction and modes (live, `bench/live.py`, `-p` chained with `--continue`)

| scenario | result |
|---|---|
| `plan` | ✅ `/plan` → the edit request is declined, the file untouched; plan file written to `~/.opencode/plan/`; `/build` → the edit is made; mode restored in each new `--continue` process |
| `compact` (manual `/compact` as the first thing a process does) | ✅ checkpoint (20 messages → 1), the codename from the first turn recalled afterwards. The summary used the `$.model.complete` fallback: a fresh process has no request to fork yet (`nothing-to-fork`) |
| `engine-auto` (Claude Code's own threshold lowered with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1`) | ✅ the engine's `auto` trigger reaches feathercode's hook; summary via `$.model.fork`, which **read 9,522 tokens from cache** (input 937); context kept |
| `auto` (feathercode's own v2 ceiling, lowered to 9.2k) | ✅ ceiling reached → in `-p` `$.session.compact()` is refused (headless), so a `/compact` is queued; summary via fork (9,205 cached); context kept |
| `prune` (opt-in) | ✅ after a turn, 7 old Read outputs (~88k tokens by chars/4) replaced with `[Old tool result content cleared]`; context kept |
| `toolsearch` | ✅ no cache break (see §2) |

After a compaction, the next request reads the cross-session system+tools
prefix (4,788) and writes the new conversation once: the expected single
re-write.

Notes:

- **Headless (`-p`/SDK)**: Claude Code refuses `$.session.compact()` between
  turns there ("compaction here runs inside a turn"). feathercode then queues
  `/compact` through `$.command.run`; it runs as an extra turn after the
  answer, so a `-p` run's JSON `result` becomes the compaction's (empty) text
  and the run takes longer (~1 min in the test). Interactive sessions call
  `$.session.compact()` directly. Mid-turn, the engine's own threshold covers
  overflow in both.
- `tokensBefore`/`tokensAfter` in the log are chars/4 estimates of what the
  hook sees; `-p` transcripts drop Bash stdout from the stored record, so
  they undercount there.
- Compaction of a subagent's own conversation is left to the engine.

## 4. Differences from OpenCode v2

| area | OpenCode v2 | feathercode | why |
|---|---|---|---|
| System block 0 | system.txt + guidance + anthropic.txt | same text, adapted tool names; harness name dropped; Claude Code's one-line security policy kept; one extra harness line about denied tool calls | policy line is safety guidance; denied calls are a Claude Code permission concept |
| Identity / instruction blocks | system blocks 1–2, frozen per epoch | Claude Code's first-message context (model, env, date, CLAUDE.md, skills) — already frozen | same cache shape; Mods can't add system blocks with their own cache marker |
| Environment template | v2 `<env>` | Claude Code's own environment attachment | same facts; v2's template came out longer, so the engine's stays |
| Instruction files | AGENTS.md only | CLAUDE.md (engine) + AGENTS.md (built-in agents-md mod) | dropping a user's CLAUDE.md is unsafe |
| Skill listing | full descriptions in XML | Claude Code's list, descriptions cut to the first sentence | token saving (6.7k → 2.9k chars); measured with no success loss |
| Tools | edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch, write, execute | Claude Code's equivalents listed with v2 wording; the rest deferred | can't remove or replace built-in schemas, only defer and re-describe |
| `execute` (Code Mode) | MCP/opencode tools via JS | not ported | ToolSearch covers deferred tools |
| Todo | none | TodoWrite/Task* deferred, todo reminder dropped | |
| Plan restriction | edit permission denied except `~/.opencode/plan` | same, via `tool.check` on Edit/Write/NotebookEdit, all loops (subagents too) | stricter: v2 relies on the reminder for subagents |
| Agent switch | agent selector | `/plan`, `/build` (+ band button where a UI exists) | |
| Max steps | trailing assistant message, `toolChoice:"none"` | not ported | `turn.step` can't add messages or set tool choice; v2 has no default `steps` |
| Compaction trigger | before every step: estimate ≥ window − max(10%, 16k) | between turns (`session.measure`) with the same formula, on the larger of the measured context and the last request's size; mid-turn, the engine's own auto threshold calls the same compaction | no pre-step hook can compact |
| Overflow retry | shrink 70/50/35% | engine's handling | |
| Summary request | same system/tools/messages + prompt | `$.model.fork` (same prefix) + prompt; `$.model.complete` on flattened text when nothing can be forked yet (a fresh `-p` process) | |
| Subagent compaction | same algorithm | engine's own | fork reads only the main thread |
| Recent part | flattened text in `<recent-context>` | same (default), or the original messages (`compaction_tail: messages`) | |
| Prune | removed | v1 prune, opt-in (off) | asked for |
| Warming keep-alive | opt-in | not ported | 1h TTL already |
| Title / summary agents | yes | no | Claude Code titles sessions |

## 5. Not possible with the Mod API (as of 2.1.293)

- Placing cache markers, or adding system blocks with their own marker.
- Changing the request's messages per request (`turn.step` only sets model/effort): no request-only reminders, no MAX_STEPS message, no `toolChoice`.
- Deleting or replacing a built-in tool's schema (only description + deferral).
- Compacting before a step from inside a turn (only between turns, or via the engine's own threshold).
- Forking a subagent's conversation for its summary.
- Reading `$` from a second module file: everything touching `$` must sit in `register.tsx`.

## 6. Environment notes

- A `claude -p` started inside a cloud session inherits the parent's session id and remote settings; `bench/run.py` strips the environment and gives the child its own `CLAUDE_CONFIG_DIR` (`--isolate`, default in the cloud).
- As root, `bypassPermissions` needs `IS_SANDBOX=1`.
- The container is still detected as remote (`remote_session_change` attachment), so cloud and local numbers differ; see `docs/local-checklist.md`.
- Claude Code's Read rejects files over 25k tokens even with offset/limit (seen without the mod too).
