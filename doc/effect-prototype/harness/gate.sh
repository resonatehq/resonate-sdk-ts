#!/bin/bash
# The conformance leg of the production gate: a fuzz run plus grade.py.
# Usage: ./gate.sh <tag> [fault-rate]   e.g. ./gate.sh it4 0.15
# Exits non-zero if the server is down, the runner reported program failures, or the grade is not clean.
# Hardened after three runs against reclaimed servers produced empty logs that the grader called "clean".
#
# NOTE: paths below are from the lost prototype (/home/user/e5, /home/user/probe). They are kept verbatim as a
# record of what the gate actually ran. WIRE=harness is load-bearing: with WIRE=sdk the harness suppresses its own
# send/recv events and the tree checker's wire-driven rules go inert.
set -u
TAG="${1:-gate}"; F="${2:-0}"
PORT=8032; [ "$F" != "0" ] && PORT=8033
LOG=/home/user/probe/execlog/logs/gate-$TAG-f$F.jsonl

# 1. the server must answer before we believe anything this run says
if ! curl -s -m 5 -o /dev/null "http://127.0.0.1:$PORT/" ; then
  echo "GATE ABORTED: no server on $PORT. Start keep-servers.sh and retry."; exit 3
fi
cd /home/user/e5 && npm run build >/dev/null 2>&1 || { echo "GATE ABORTED: build failed"; exit 3; }
cd /home/user/probe/execlog
SDK_PATH=/home/user/e5/dist/index.js EFFECT_PATH=/home/user/e5/node_modules/effect/dist/esm/index.js \
  PROGRAMS=/home/user/probe/fuzz/programs-steps-12.json BASE=http://127.0.0.1:$PORT \
  RUN_ID="g$TAG$((RANDOM%1000))" SEED=1 FAULT=$F ACT=1 WIRE=harness LOG=$LOG \
  timeout 900 node --experimental-strip-types run-effect.mts > /tmp/gate-$TAG.out 2>&1
tail -3 /tmp/gate-$TAG.out

# 2. the runner's own program-failure list must be empty
FAILS=$(python3 - "$TAG" <<'PY'
import json,sys,re
txt=open(f"/tmp/gate-{sys.argv[1]}.out").read()
m=re.search(r'"failures":\s*\[(.*?)\]', txt, re.S)
print(0 if (m and not m.group(1).strip()) else (1 if m else -1))
PY
)
[ "$FAILS" = "0" ] || echo "GATE WARNING: runner failures field is '$FAILS' (0=empty, 1=non-empty, -1=not found)"

# 3. the grade must be clean, and the grader now refuses to grade an empty run
python3 /home/user/probe/grade.py "$LOG"; G=$?
[ "$FAILS" = "0" ] && [ "$G" = "0" ] || { echo "GATE FAIL (failures=$FAILS grade=$G)"; exit 1; }
echo "GATE PASS"
