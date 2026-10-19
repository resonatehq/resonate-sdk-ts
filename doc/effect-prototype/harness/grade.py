#!/usr/bin/env python3
"""Standard verdict for a seam log. Prints the tree checker's ruling AND the SDK's own mirror self-reports, because
grading on the tree alone is how a defect the SDK was reporting about itself went unread for four rounds.

A mirror self-report is not automatically a failure: SPEC's R6, as written, condemns the mere arrival of a response
to a request issued before a platform failure. That arrival is legitimate (see tree.py's acted_late). So
self-reports are split into the ones the amended rule permits (a post-abandon `created`/`settled` observation) and
everything else, which is unexplained and must be read.
Usage: grade.py LOG..."""
import json, sys, pathlib, collections, re
sys.path.insert(0, str(pathlib.Path(__file__).parent / "tree"))
import tree as T

# Phrasing differs per SDK ("after the attempt was abandoned (R6)" vs "after the attempt closed on a platform
# failure"), and the node id sits before or after "event". Match the shape, not one author's wording, or the
# grader cries wolf on harmless observations and buries the real acts among them.
PERMITTED = re.compile(r"event (created|settled)\b.*after the attempt (was abandoned|closed)")

def grade(path):
    t = T.check(path)
    reports = [json.loads(l).get("detail", "") for l in open(path) if '"mirror_violation"' in l]
    permitted = [r for r in reports if PERMITTED.search(r)]
    unexplained = [r for r in reports if not PERMITTED.search(r)]
    late = sum(1 for l in open(path) if '"ev":"decide"' in l)  # decisions, for scale
    return t, reports, permitted, unexplained, late

# A log that shows no work must never grade as "clean". An empty or near-empty run — servers down, a bad path, the
# runner dying on its first request — produces no violations precisely because it produced no behaviour, and a
# checker that reports "clean" on it turns the gate into a rubber stamp. Caught exactly that way: three runs with
# the servers reclaimed graded clean with nodes=0.
MIN_NODES = 20          # the smallest corpus program set still builds far more than this; tune if the corpus shrinks

def sanity(path, t):
    """Reasons this log cannot support a verdict at all. Returns a list of strings; empty means gradeable."""
    bad = []
    fails = sum(1 for l in open(path) if '"ev":"fail"' in l)
    evs = sum(1 for l in open(path) if l.strip())
    if len(t.nodes) < MIN_NODES:
        bad.append(f"only {len(t.nodes)} nodes (< {MIN_NODES}): the run did little or nothing")
    if evs and fails / evs > 0.5:
        bad.append(f"{fails}/{evs} events are transport failures: the server was probably unreachable")
    if evs < 10:
        bad.append(f"only {evs} events in the log")
    return bad

if __name__ == "__main__":
    worst = 0
    for p in sys.argv[1:]:
        t, reports, permitted, unexplained, _ = grade(p)
        by = collections.Counter(v[0] for v in t.viol)
        bad = sanity(p, t)
        if bad:
            worst = max(worst, 2)
            print(f"{pathlib.Path(p).name:26s} nodes={len(t.nodes):4d} tree=INVALID — NOT A VERDICT")
            for b in bad: print("     x", b)
            continue
        verdict = "clean" if not t.viol else dict(by)
        if t.viol or unexplained: worst = max(worst, 1)
        flag = "" if not unexplained else f"  UNEXPLAINED SELF-REPORTS={len(unexplained)}"
        print(f"{pathlib.Path(p).name:26s} nodes={len(t.nodes):4d} tree={str(verdict):60s} "
              f"self-reports={len(reports):3d} (permitted-observation={len(permitted)}){flag}")
        for r in unexplained[:3]: print("     !", r[:150])
    sys.exit(worst)
