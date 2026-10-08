#!/usr/bin/env bash
# Injects the bug: the \t escape decodes to a space instead of a tab.
set -e
python3 - <<'PY'
p = "src/tomli/_parser.py"
s = open(p).read()
old = '"\\\\t": "\\u0009"'
assert old in s, "pattern not found"
open(p, "w").write(s.replace(old, '"\\\\t": "\\u0020"'))
PY
git -c user.email=b@b -c user.name=bench commit -qam "wip"
