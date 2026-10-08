#!/usr/bin/env python3
"""feathercode bench runner.

For each task: clone the repo at its commit into a temp dir, run its setup,
run `claude -p` with the feathercode plugin (features chosen per run), run the
task's check, and keep the plugin's JSONL log plus claude's JSON result.

  python3 bench/run.py --label baseline --features observe
  python3 bench/run.py --label stage1 --features prompt --tasks tomli-explain,tomli-tabfix
  python3 bench/analyze.py bench/results/baseline bench/results/stage1

Runs on a local machine as well as in a cloud session. --isolate (default:
on when CLAUDE_CODE_REMOTE is set) runs claude with a minimal environment and
its own CLAUDE_CONFIG_DIR so the parent session's settings do not leak in;
locally, leave it off so your normal login is used.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TASKS = ROOT / "bench" / "tasks"
PLUGIN = ROOT / "plugin"

KEEP_ENV = [
    "HOME", "PATH", "LANG", "LC_ALL", "TERM", "USER", "SHELL", "TMPDIR",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE",
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
]
# Variables that tie a child to the parent Claude Code session.
LEAKY_PREFIXES = ("CLAUDE_CODE_", "CLAUDECODE", "CLAUDE_AFTER", "CLAUDE_AUTO", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_ENABLE", "CLAUDE_SESSION")


def sh(cmd, cwd=None, env=None, timeout=600, check=True):
    p = subprocess.run(cmd, cwd=cwd, env=env, timeout=timeout, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(f"{cmd} failed ({p.returncode}): {p.stderr[-2000:]}")
    return p


def load_tasks(ids):
    tasks = []
    for d in sorted(TASKS.iterdir()):
        if not (d / "task.json").exists():
            continue
        t = json.loads((d / "task.json").read_text())
        if ids and t["id"] not in ids:
            continue
        t["dir"] = d
        tasks.append(t)
    return tasks


def child_env(args, log_dir, cfg_dir):
    if args.isolate:
        env = {k: os.environ[k] for k in KEEP_ENV if k in os.environ}
        env["CLAUDE_CONFIG_DIR"] = str(cfg_dir)
    else:
        env = {k: v for k, v in os.environ.items() if not k.startswith(LEAKY_PREFIXES)}
    if os.geteuid() == 0:
        env["IS_SANDBOX"] = "1"  # bypassPermissions is refused for root otherwise
    env["FEATHERCODE_FEATURES"] = args.features
    env["FEATHERCODE_LOG_DIR"] = str(log_dir)
    if args.prune is not None:
        env["FEATHERCODE_PRUNE"] = args.prune
    return env


def prepare(task, work):
    sh(["git", "init", "-q"], cwd=work)
    sh(["git", "fetch", "-q", "--depth", "1", task["repo"], task["commit"]], cwd=work, timeout=300)
    sh(["git", "checkout", "-q", "FETCH_HEAD"], cwd=work)
    setup = task["dir"] / "setup.sh"
    if setup.exists():
        sh(["bash", str(setup)], cwd=work)


def run_one(task, rep, args, out):
    run_dir = out / f"{task['id']}-r{rep}"
    if run_dir.exists():
        shutil.rmtree(run_dir)
    log_dir = run_dir / "logs"
    log_dir.mkdir(parents=True)
    cfg_dir = out.parent / ".claude-config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f"fc-{task['id']}-"))
    rec = {"task": task["id"], "kind": task.get("kind"), "rep": rep, "label": args.label, "features": args.features, "model": args.model}
    try:
        prepare(task, work)
        cmd = [
            args.claude, "-p", task["prompt"],
            "--model", args.model,
            "--output-format", "json",
            "--permission-mode", "bypassPermissions",
        ]
        if not args.no_plugin:
            cmd += ["--plugin-dir", str(PLUGIN)]
        t0 = time.time()
        p = subprocess.run(cmd, cwd=work, env=child_env(args, log_dir, cfg_dir), capture_output=True, text=True, timeout=args.timeout)
        rec["seconds"] = round(time.time() - t0, 1)
        rec["exit"] = p.returncode
        (run_dir / "stderr.txt").write_text(p.stderr)
        try:
            res = json.loads(p.stdout)
        except json.JSONDecodeError:
            res = {"raw": p.stdout[-4000:]}
        (run_dir / "claude.json").write_text(json.dumps(res, indent=1))
        rec["result"] = {k: res.get(k) for k in ("num_turns", "total_cost_usd", "usage", "modelUsage", "session_id", "is_error", "subtype")}
        c = subprocess.run(["bash", str(task["dir"] / "check.sh")], cwd=work, capture_output=True, text=True, timeout=600)
        rec["pass"] = c.returncode == 0
        rec["check_output"] = (c.stdout + c.stderr)[-2000:]
        diff = sh(["git", "diff", "--stat", "HEAD"], cwd=work, check=False).stdout
        rec["diffstat"] = diff[-1500:]
    except Exception as ex:  # noqa: BLE001
        rec["pass"] = False
        rec["error"] = str(ex)[-2000:]
    finally:
        if args.keep:
            rec["workdir"] = str(work)
        else:
            shutil.rmtree(work, ignore_errors=True)
    rec["logs"] = sorted(str(p.relative_to(out)) for p in log_dir.glob("*.jsonl"))
    (run_dir / "run.json").write_text(json.dumps(rec, indent=1))
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--features", default="observe", help="observe | all | comma list of prompt,cache,tools,modes,agents,compact")
    ap.add_argument("--tasks", default="", help="comma list of task ids (default: all)")
    ap.add_argument("--model", default=os.environ.get("BENCH_MODEL", "sonnet"))
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--prune", choices=["0", "1"], default=None)
    ap.add_argument("--claude", default=os.environ.get("CLAUDE_BIN", "claude"))
    ap.add_argument("--out", default=str(ROOT / "bench" / "results"))
    ap.add_argument("--keep", action="store_true", help="keep the work dirs")
    ap.add_argument("--no-plugin", action="store_true", help="run without the plugin (no logs)")
    iso = ap.add_mutually_exclusive_group()
    iso.add_argument("--isolate", dest="isolate", action="store_true")
    iso.add_argument("--no-isolate", dest="isolate", action="store_false")
    ap.set_defaults(isolate=bool(os.environ.get("CLAUDE_CODE_REMOTE")))
    args = ap.parse_args()

    ids = {s for s in args.tasks.split(",") if s}
    tasks = load_tasks(ids)
    if not tasks:
        sys.exit("no tasks")
    out = Path(args.out) / args.label
    out.mkdir(parents=True, exist_ok=True)
    ver = sh([args.claude, "--version"], check=False).stdout.strip()
    (out / "meta.json").write_text(json.dumps({"label": args.label, "features": args.features, "model": args.model, "claude": ver, "isolate": args.isolate, "time": time.strftime("%Y-%m-%dT%H:%M:%S")}, indent=1))
    for task in tasks:
        for rep in range(1, args.repeat + 1):
            rec = run_one(task, rep, args, out)
            u = (rec.get("result") or {}).get("usage") or {}
            print(f"{rec['task']} r{rep}: {'PASS' if rec.get('pass') else 'FAIL'} {rec.get('seconds', '?')}s "
                  f"in={u.get('input_tokens')} out={u.get('output_tokens')} read={u.get('cache_read_input_tokens')} "
                  f"write={u.get('cache_creation_input_tokens')} {rec.get('error', '')}", flush=True)


if __name__ == "__main__":
    main()
