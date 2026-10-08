#!/usr/bin/env bash
set -e
python3 -c "
from more_itertools import count_runs
assert count_runs('aaabbc') == 3
assert count_runs([]) == 0
assert count_runs([1, 2, 3, 4], key=lambda x: x // 2) == 3
assert count_runs(iter('abab')) == 4
"
grep -q 'count_runs' more_itertools/more.pyi
grep -q 'count_runs' tests/test_more.py
python3 -m unittest -q tests.test_more 2>&1 | tail -1 | grep -q '^OK'
