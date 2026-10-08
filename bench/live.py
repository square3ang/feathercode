#!/usr/bin/env python3
"""Multi-turn `claude -p` scenarios chained with --continue (no UI needed).

  python3 bench/live.py plan      # /plan blocks edits, /build lifts it, mode survives --continue
  python3 bench/live.py compact   # builds a long session, runs /compact, checks recall after it
  python3 bench/live.py prune     # same session shape with prune on, checks tool outputs cleared
  python3 bench/live.py toolsearch # loads deferred tools mid-session, checks for cache breaks
  python3 bench/live.py auto      # feathercode's ceiling trigger (lowered), summary via fork
  python3 bench/live.py engine-auto # the engine's auto threshold (lowered) through the hook

Each step prints the reply head and the plugin's log lines for it; a scenario
ends with PASS/FAIL lines. Uses the same environment handling as run.py.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run import KEEP_ENV, LEAKY_PREFIXES, PLUGIN, ROOT, settings_for  # noqa: E402

OUT = ROOT / "bench" / "results" / "live"


def env_for(extra):
    isolate = bool(os.environ.get("CLAUDE_CODE_REMOTE"))
    if isolate:
        env = {k: os.environ[k] for k in KEEP_ENV if k in os.environ}
        cfg = ROOT / "bench" / "results" / ".claude-config"
        cfg.mkdir(parents=True, exist_ok=True)
        env["CLAUDE_CONFIG_DIR"] = str(cfg)
    else:
        env = {k: v for k, v in os.environ.items() if not k.startswith(LEAKY_PREFIXES)}
    if os.geteuid() == 0:
        env["IS_SANDBOX"] = "1"
    env.update(extra)
    return env


class Session:
    def __init__(self, name, options=None, extra=None, model=None):
        self.dir = Path(tempfile.mkdtemp(prefix=f"fc-live-{name}-"))
        self.log_dir = OUT / name
        if self.log_dir.exists():
            shutil.rmtree(self.log_dir)
        self.log_dir.mkdir(parents=True)
        self.env = env_for(extra or {})
        self.options = {"features": "all", **(options or {})}
        self.session_id = None
        self.model = model or os.environ.get("BENCH_MODEL", "sonnet")
        self.started = False
        self.results = []
        subprocess.run(["git", "init", "-q"], cwd=self.dir)

    def say(self, prompt, timeout=600):
        cmd = [os.environ.get("CLAUDE_BIN", "claude"), "-p", prompt, "--model", self.model, "--output-format", "json",
               "--permission-mode", "bypassPermissions", "--plugin-dir", str(PLUGIN),
               "--settings", settings_for(self.options)]
        if self.started:
            cmd.insert(1, "--continue")
        p = subprocess.run(cmd, cwd=self.dir, env=self.env, capture_output=True, text=True, timeout=timeout)
        self.started = True
        try:
            res = json.loads(p.stdout)
        except json.JSONDecodeError:
            res = {"result": p.stdout[-2000:], "stderr": p.stderr[-2000:]}
        text = res.get("result") or ""
        self.session_id = self.session_id or res.get("session_id")
        u = res.get("usage") or {}
        print(f"\n> {prompt[:100]}\n< {text[:300]!r}\n  usage in={u.get('input_tokens')} read={u.get('cache_read_input_tokens')} write={u.get('cache_creation_input_tokens')} out={u.get('output_tokens')}")
        return text

    def log(self):
        recs = []
        for f in sorted((PLUGIN / "logs").glob(f"{self.session_id}*.jsonl")) if self.session_id else []:
            shutil.copy(f, self.log_dir / f.name)
        for f in sorted(self.log_dir.glob("*.jsonl")):
            recs += [json.loads(line) for line in f.read_text().splitlines() if line.strip()]
        return recs

    def check(self, name, ok, detail=""):
        self.results.append((name, ok))
        print(f"{'PASS' if ok else 'FAIL'} {name} {detail}")

    def done(self):
        (self.log_dir / "result.json").write_text(json.dumps(self.results))
        shutil.rmtree(self.dir, ignore_errors=True)
        return all(ok for _, ok in self.results)


def plan():
    s = Session("plan")
    (s.dir / "a.py").write_text("print('hi')\n")
    s.say("/plan")
    s.say("Change a.py so it prints 'bye' instead of 'hi'.")
    s.check("plan blocks the edit", (s.dir / "a.py").read_text() == "print('hi')\n")
    s.say("Write your plan for that change into a markdown file in the plan directory you were given.")
    plans = list((s.dir / ".opencode" / "plan").glob("*.md"))
    s.check("plan dir writable", len(plans) > 0, str(plans[:3]))
    s.say("/build")
    s.say("Now make the change to a.py.")
    s.check("build edits", "bye" in (s.dir / "a.py").read_text())
    modes = [r.get("mode") for r in s.log() if r.get("ev") == "mode"]
    s.check("mode switches logged", modes == ["plan", "build"], str(modes))
    return s.done()


LONG_FACT = "The deployment codename is BLUE-HERON-42."


def build_long(s, rounds):
    (s.dir / "data.txt").write_text("\n".join(f"line {i}: " + "lorem ipsum dolor sit amet " * 8 for i in range(400)))
    s.say(f"Remember this for later: {LONG_FACT} Then read data.txt and tell me its line count.")
    for i in range(rounds):
        s.say(f"Read data.txt again and tell me what line {i * 37 % 400} says, briefly.")


def compact():
    s = Session("compact", {"keep_tokens": 3000})
    build_long(s, 4)
    s.say("/compact")
    recs = s.log()
    comp = [r for r in recs if r.get("ev") == "compact" and r.get("trigger") == "manual"]
    summ = [r for r in recs if r.get("ev") == "summary"]
    s.check("manual compaction ran through feathercode", bool(comp) and not comp[-1].get("skip"), json.dumps(comp[-1:]))
    s.check("summary via fork", any(r.get("via") == "fork" and r.get("ok") for r in summ), json.dumps(summ[-1:]))
    if summ and summ[-1].get("usage"):
        u = summ[-1]["usage"]
        s.check("fork read the cached prefix", u.get("cache_read_input_tokens", 0) > 0, json.dumps(u))
    reply = s.say("What is the deployment codename I told you at the start? Answer with the codename only.")
    s.check("context kept across compaction", "BLUE-HERON-42" in reply)
    steps = [r for r in s.log() if r.get("ev") == "step"]
    if steps:
        last = steps[-1]
        print(f"  after compaction: input {last['input']} read {last['cacheRead']} write {last['cacheWrite']}")
    return s.done()


def prune():
    s = Session("prune", {"compaction_prune": True})
    words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore " * 2
    for f in range(10):
        (s.dir / f"part{f}.txt").write_text("\n".join(f"part {f} row {i} {words}" for i in range(150)))
    s.say(f"Remember: {LONG_FACT} Say OK.")
    for f in range(10):
        s.say(f"Use the Read tool to read the whole of part{f}.txt (no Bash), then tell me its last row number. Nothing else.")
    s.say("Say OK.")
    recs = s.log()
    pr = [r for r in recs if r.get("ev") == "prune"]
    s.check("prune cleared old outputs", bool(pr), json.dumps(pr[-1:]))
    reply = s.say("What is the deployment codename? Codename only.")
    s.check("context kept after prune", "BLUE-HERON-42" in reply)
    return s.done()


def auto():
    """feathercode's own trigger (ceiling lowered to ~20k) compacts between turns, via fork."""
    s = Session("auto", {"compaction_buffer": 990800, "keep_tokens": 3000})
    build_long(s, 6)
    recs = s.log()
    req = [r for r in recs if r.get("ev") == "compact-request"]
    comp = [r for r in recs if r.get("ev") == "compact" and r.get("trigger") in ("plugin", "manual") and not r.get("skip")]
    summ = [r for r in recs if r.get("ev") == "summary"]
    s.check("ceiling trigger fired", bool(req), json.dumps(req[:1]))
    s.check("compaction ran", bool(comp), json.dumps(comp[:1]))
    s.check("summary via fork", any(r.get("via") == "fork" and r.get("ok") for r in summ), json.dumps(summ[:2]))
    forks = [r for r in summ if r.get("via") == "fork" and r.get("usage")]
    if forks:
        u = forks[0]["usage"]
        s.check("fork read the cached prefix", u.get("cache_read_input_tokens", 0) > 0, json.dumps(u))
    reply = s.say("What is the deployment codename I told you at the start? Codename only.")
    s.check("context kept across compaction", "BLUE-HERON-42" in reply)
    return s.done()


def engine_auto():
    """The engine's own auto threshold (lowered) goes through feathercode's compaction."""
    s = Session("engine-auto", {"keep_tokens": 3000}, {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "1"})
    build_long(s, 8)
    recs = s.log()
    comp = [r for r in recs if r.get("ev") == "compact" and r.get("trigger") == "auto"]
    summ = [r for r in recs if r.get("ev") == "summary"]
    s.check("engine auto trigger reached the hook", bool(comp), json.dumps(comp[:1]))
    s.check("summarised by feathercode", bool(summ), json.dumps(summ[:2]))
    reply = s.say("What is the deployment codename I told you at the start? Codename only.")
    s.check("context kept across compaction", "BLUE-HERON-42" in reply)
    return s.done()


def toolsearch():
    """Loads deferred tools mid-session and checks the cache reads around it."""
    s = Session("toolsearch")
    nb = {"cells": [{"cell_type": "code", "metadata": {}, "source": ["print('hi')"], "outputs": [], "execution_count": None}],
          "metadata": {}, "nbformat": 4, "nbformat_minor": 5}
    (s.dir / "nb.ipynb").write_text(json.dumps(nb))
    s.say("Read nb.ipynb and tell me what the cell prints.")
    s.say("Use the NotebookEdit tool (load it with ToolSearch first) to change that cell so it prints 'bye'. Then say done.")
    s.say("Now use the Workflow tool's schema lookup via ToolSearch (just load it with ToolSearch, do not run it) and tell me its first parameter name.")
    recs = s.log()
    searches = [r for r in recs if r.get("ev") == "tool" and r.get("tool") == "ToolSearch"]
    steps = [r for r in recs if r.get("ev") == "step" and r.get("loop") == "main"]
    breaks = [r for r in steps if r.get("isBreak")]
    s.check("ToolSearch was used", len(searches) > 0, f"{len(searches)} calls")
    s.check("no cache break after loading deferred tools", not breaks, json.dumps([{k: b[k] for k in ("index", "lost", "causes")} for b in breaks]))
    for st in steps:
        print(f"  step {st['turnId'][:6]}/{st['index']}: read {st['cacheRead']} write {st['cacheWrite']} tools {st.get('tools')} break={st['isBreak']}")
    return s.done()


if __name__ == "__main__":
    which = sys.argv[1:] or ["plan", "compact", "prune", "toolsearch"]
    ok = all([{"plan": plan, "compact": compact, "prune": prune, "toolsearch": toolsearch, "auto": auto, "engine-auto": engine_auto}[w]() for w in which])
    sys.exit(0 if ok else 1)
