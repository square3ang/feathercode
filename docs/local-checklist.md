# Local check (to run on your machine)

The cloud session can't show a UI and runs `-p` with the short "lean" prompt,
so these checks are left for a local interactive session.

## 0. Install

Either from this checkout:

```sh
claude --plugin-dir /path/to/feathercode/plugin
```

or from GitHub (once the branch is merged):

```
/plugin install feathercode --marketplace square3ang/feathercode
```

Write down `claude --version` here: `____________` (cloud measurements: 2.1.293).

## 1. UI

- [ ] `/plan`: the band above the prompt shows **plan** with a "Switch to build" button.
- [ ] Press the button (ctrl+x tab to focus the band, or click): the band disappears and `/feathercode-stats` says `mode: build`.
- [ ] `/plan`, then ask for an edit: the Edit/Write call is denied with `Cannot use Edit to modify files outside the Plan directory: ~/.opencode/plan`.
- [ ] `/build`: edits work again.
- [ ] If `/plan` or `/build` collides with a built-in command, the mod registers `/fc-plan` / `/fc-build` instead (the command's own output says which one to use).
- [ ] `/feathercode-panel` opens the stats pane (fullscreen terminal docks it beside the transcript).
- [ ] `panel: true` in `/config` opens it at start (at 144+ columns).
- [ ] VS Code / desktop: `/plan` still blocks edits; the band shows where the surface draws `AbovePrompt`.

## 2. Diffs and checkpoints

- [ ] An Edit in build mode still shows the diff and asks for permission as usual.
- [ ] Rewind (esc esc) to a checkpoint before an edit restores the file.
- [ ] A denied plan-mode edit leaves no checkpoint entry.

## 3. Cache numbers in an interactive session

Work normally for 15–30 minutes on a real task, then:

- [ ] `/feathercode-stats`: cache hit % (cloud bench: see `bench/results/REPORT.md`) and the number of cache breaks.
- [ ] `python3 bench/analyze.py ~/.claude/feathercode/logs/<session>.jsonl`: the cause table. Expected causes: `compaction(...)`, `idle Nm (TTL)` after more than an hour away, and `ToolSearch(...)` if a deferred tool was loaded.
- [ ] Compare with a session without the mod: start `claude` without `--plugin-dir`, and before that run one with `FEATHERCODE_FEATURES=observe` to get the same log without changes.

## 4. Bench locally (optional)

```sh
python3 bench/run.py --label local-baseline --features observe --no-isolate
python3 bench/run.py --label local-all --features all --no-isolate
python3 bench/analyze.py bench/results/local-baseline bench/results/local-all
python3 bench/live.py plan compact
```

Locally, the interactive system prompt is the full one, not "lean", so
expect a larger baseline and a larger saving than in the cloud numbers.

## 5. Things to report back

- Your `claude --version`.
- Anything in the transcript like `feathercode: <event> hook was skipped` or `ui.render (...) refused`.
- Cache hit %, breaks and their causes from step 3.
