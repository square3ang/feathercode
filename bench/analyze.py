#!/usr/bin/env python3
"""Summarise feathercode JSONL logs as markdown.

  python3 bench/analyze.py bench/results/baseline [bench/results/stage1 ...]
  python3 bench/analyze.py ~/.claude/feathercode/logs/<session>.jsonl

A results dir (from run.py) gives a per-task table with pass/fail; several
dirs give a comparison against the first. A bare .jsonl file (an interactive
session's log) gives the same tables for that session alone. Every input also
gets a cache-break cause table: each request whose cache read fell short of
the previous request's prompt, attributed to what happened in between.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path


def read_jsonl(path):
    out = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def summarize(records):
    s = defaultdict(float)
    s["sections"] = None
    first = None
    for r in records:
        ev = r.get("ev")
        if ev == "step":
            s["requests"] += 1
            for k in ("input", "output", "cacheRead", "cacheWrite"):
                s[k] += r.get(k, 0)
            if r.get("loop") != "main":
                s["sub_requests"] += 1
            if r.get("isBreak"):
                s["breaks"] += 1
                s["lost"] += r.get("lost", 0)
            if first is None and r.get("loop") == "main":
                first = r
        elif ev == "compose" and s["sections"] is None:
            s["sections"] = r.get("sections")
        elif ev == "describe":
            if not r.get("deferred"):
                s["tools_listed"] += 1
                s["tool_chars"] += r.get("chars", 0)
        elif ev == "attach":
            s["attach_chars"] += r.get("chars") or 0
        elif ev == "tool" and r.get("tool") == "ToolSearch":
            s["toolsearch"] += 1
        elif ev == "compact" and r.get("trigger") != "precompute" and not r.get("skip"):
            s["compactions"] += 1
    if first:
        s["first_prompt"] = first.get("input", 0) + first.get("cacheRead", 0) + first.get("cacheWrite", 0)
    secs = s["sections"] or []
    s["sys_chars"] = sum(x.get("chars", 0) for x in secs)
    prompt = s["input"] + s["cacheRead"] + s["cacheWrite"]
    s["hit"] = 100 * s["cacheRead"] / prompt if prompt else 0
    return s


def breaks(records):
    rows = []
    for r in records:
        if r.get("ev") == "step" and r.get("isBreak"):
            rows.append(r)
    return rows


def cause_key(c):
    # Collapse parameters so causes group: "ToolSearch(select:X)" -> "ToolSearch"
    for sep in ("(", " "):
        if sep in c and not c.startswith(("model", "effort", "tool set", "idle")):
            return c.split(sep)[0]
    return c.split(" ")[0] if c.startswith(("model", "effort", "idle")) else c


def load_dir(d):
    d = Path(d)
    runs = []
    for rj in sorted(d.glob("*/run.json")):
        rec = json.loads(rj.read_text())
        recs = []
        for lg in sorted((rj.parent / "logs").glob("*.jsonl")):
            recs += read_jsonl(lg)
        rec["records"] = recs
        rec["summary"] = summarize(recs)
        runs.append(rec)
    meta = json.loads((d / "meta.json").read_text()) if (d / "meta.json").exists() else {"label": d.name}
    return meta, runs


def fmt(n):
    return f"{int(n):,}"


def task_table(label, runs):
    lines = [f"### {label}", "", "| task | pass | req (sub) | input | output | cache read | cache write | hit % | breaks | first prompt | sys chars | tools listed (chars) | turns | sec | cost $ |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    tot = defaultdict(float)
    for r in runs:
        s = r["summary"]
        res = r.get("result") or {}
        lines.append(
            f"| {r['task']}#{r['rep']} | {'✅' if r.get('pass') else '❌'} | {int(s['requests'])} ({int(s['sub_requests'])}) | {fmt(s['input'])} | {fmt(s['output'])} | {fmt(s['cacheRead'])} | {fmt(s['cacheWrite'])} | {s['hit']:.1f} | {int(s['breaks'])} | {fmt(s.get('first_prompt', 0))} | {fmt(s['sys_chars'])} | {int(s['tools_listed'])} ({fmt(s['tool_chars'])}) | {res.get('num_turns') or ''} | {r.get('seconds', '')} | {(res.get('total_cost_usd') or 0):.3f} |"
        )
        for k in ("input", "output", "cacheRead", "cacheWrite", "requests", "breaks"):
            tot[k] += s[k]
        tot["pass"] += 1 if r.get("pass") else 0
        tot["n"] += 1
        tot["sec"] += r.get("seconds") or 0
        tot["cost"] += res.get("total_cost_usd") or 0
    prompt = tot["input"] + tot["cacheRead"] + tot["cacheWrite"]
    hit = 100 * tot["cacheRead"] / prompt if prompt else 0
    lines.append(f"| **total** | {int(tot['pass'])}/{int(tot['n'])} | {int(tot['requests'])} | {fmt(tot['input'])} | {fmt(tot['output'])} | {fmt(tot['cacheRead'])} | {fmt(tot['cacheWrite'])} | {hit:.1f} | {int(tot['breaks'])} | | | | | {tot['sec']:.0f} | {tot['cost']:.3f} |")
    return lines, tot


def cause_table(records):
    agg = defaultdict(lambda: [0, 0])
    rows = breaks(records)
    for r in rows:
        causes = r.get("causes") or ["(unknown)"]
        for c in {cause_key(c) for c in causes}:
            agg[c][0] += 1
            agg[c][1] += r.get("lost", 0)
    lines = ["| cause (candidate) | breaks | tokens re-written |", "|---|---|---|"]
    for c, (n, lost) in sorted(agg.items(), key=lambda kv: -kv[1][1]):
        lines.append(f"| {c} | {n} | {fmt(lost)} |")
    if not rows:
        lines.append("| (no cache breaks) | 0 | 0 |")
    detail = ["", "<details><summary>break details</summary>", "", "| loop | turn/step | lost | gap s | causes |", "|---|---|---|---|---|"]
    for r in rows[:60]:
        detail.append(f"| {r.get('loop')} | {str(r.get('turnId', ''))[:8]}/{r.get('index')} | {fmt(r.get('lost', 0))} | {round(r.get('gapMs', 0) / 1000)} | {'; '.join(r.get('causes') or []) or '?'} |")
    detail += ["", "</details>"]
    return lines + detail


def attach_table(records):
    agg = defaultdict(lambda: [0, 0])
    for r in records:
        if r.get("ev") == "attach":
            agg[r.get("type")][0] += 1
            agg[r.get("type")][1] += r.get("chars") or 0
    lines = ["| attachment | count | chars |", "|---|---|---|"]
    for k, (n, c) in sorted(agg.items(), key=lambda kv: -kv[1][1]):
        lines.append(f"| {k} | {n} | {fmt(c)} |")
    return lines


def main(paths):
    out = ["# feathercode bench report", ""]
    totals = []
    for p in paths:
        p = Path(p)
        if p.is_file():
            recs = read_jsonl(p)
            s = summarize(recs)
            out += [f"## {p.name}", "", f"requests {int(s['requests'])}, input {fmt(s['input'])}, output {fmt(s['output'])}, cache read {fmt(s['cacheRead'])}, cache write {fmt(s['cacheWrite'])}, hit {s['hit']:.1f}%, breaks {int(s['breaks'])}", "", "#### cache breaks", ""] + cause_table(recs) + ["", "#### attachments", ""] + attach_table(recs) + [""]
            continue
        meta, runs = load_dir(p)
        lines, tot = task_table(f"{meta.get('label')} — features `{meta.get('features')}` · model {meta.get('model')} · {meta.get('claude', '')}", runs)
        totals.append((meta.get("label"), tot))
        allrecs = [x for r in runs for x in r["records"]]
        out += ["## " + str(meta.get("label")), ""] + lines + ["", "#### cache breaks (all tasks)", ""] + cause_table(allrecs) + ["", "#### attachments (all tasks)", ""] + attach_table(allrecs) + [""]
    if len(totals) > 1:
        base = totals[0][1]
        out += ["## comparison (vs first)", "", "| label | pass | requests | input | output | cache read | cache write | hit % | breaks | Δ cache write | Δ total in+write | sec |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for label, t in totals:
            prompt = t["input"] + t["cacheRead"] + t["cacheWrite"]
            hit = 100 * t["cacheRead"] / prompt if prompt else 0
            dw = (t["cacheWrite"] / base["cacheWrite"] - 1) * 100 if base["cacheWrite"] else 0
            cost_like = t["input"] + t["cacheWrite"]
            base_like = base["input"] + base["cacheWrite"]
            di = (cost_like / base_like - 1) * 100 if base_like else 0
            out.append(f"| {label} | {int(t['pass'])}/{int(t['n'])} | {int(t['requests'])} | {fmt(t['input'])} | {fmt(t['output'])} | {fmt(t['cacheRead'])} | {fmt(t['cacheWrite'])} | {hit:.1f} | {int(t['breaks'])} | {dw:+.1f}% | {di:+.1f}% | {t['sec']:.0f} |")
    print("\n".join(out))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
