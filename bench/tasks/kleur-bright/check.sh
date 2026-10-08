#!/usr/bin/env bash
set -e
FORCE_COLOR=1 node --input-type=module -e "
import k from './index.mjs';
import { redBright, bgRedBright } from './colors.mjs';
const eq = (a, b) => { if (a !== b) throw new Error(JSON.stringify([a, b])) };
eq(k.redBright('x'), '\x1b[91mx\x1b[39m');
eq(k.bgRedBright('x'), '\x1b[101mx\x1b[49m');
eq(k.bold().redBright('x'), '\x1b[1m\x1b[91mx\x1b[22m\x1b[39m');
eq(redBright('x'), '\x1b[91mx\x1b[39m');
eq(bgRedBright('x'), '\x1b[101mx\x1b[49m');
"
FORCE_COLOR=1 node -e "
const k = require('./index.js'); const c = require('./colors.js');
if (k.redBright('x') !== '\x1b[91mx\x1b[39m') throw 1;
if (c.bgRedBright('x') !== '\x1b[101mx\x1b[49m') throw 2;
"
grep -q redBright index.d.ts && grep -q bgRedBright colors.d.ts
