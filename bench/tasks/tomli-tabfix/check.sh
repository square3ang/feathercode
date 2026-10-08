#!/usr/bin/env bash
set -e
git diff --quiet HEAD -- tests
PYTHONPATH=src python3 -m unittest -q 2>&1 | tail -1 | grep -q '^OK'
