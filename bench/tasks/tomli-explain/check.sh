#!/usr/bin/env bash
# Pass: ANSWER.txt names parse_basic_str_escape (or its multiline wrapper).
set -e
head -1 ANSWER.txt | grep -Eq 'parse_basic_str_escape'
