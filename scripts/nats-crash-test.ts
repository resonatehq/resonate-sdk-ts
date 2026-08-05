// Durability under total broker loss.
//
// Kills nats-server while a lineage has an armed deadline, lets that deadline
// pass while nothing at all is running, restarts, and checks that the timer
// fired and the state survived. This cannot be a jest test — it terminates the
// server other tests share — so it runs standalone:
//
//   npx tsx scripts/nats-crash-test.ts /path/to/nats-server /tmp/natsjs
import { execFileSync, spawn } from "node:child_process";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { JetStreamLog } from "../src/network/server/jetstream.js";
import {
  jetStreamLogBinding,
  jetStreamTimerBinding,
  resonateStreamConfig,
} from "../src/network/server/nats-binding.js";
import { JetStreamTimerService, originFromScheduler, SCHEDULER_HEADER } from "../src/network/server/nats-timer.js";
import { CollectingTransport, OriginRuntime } from "../src/network/server/runtime.js";
import { snapshot } from "../src/network/server/state.js";

const BIN = process.argv[2];
const DIR = process.argv[3] ?? "/tmp/natsjs";
const URL = "127.0.0.1:4222";
const S = "CRASH",
  LOG = "cr.log",
  TM = "cr.tm",
  TK = "cr.tk";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string) => {
  console.error("FAIL:", m);
  process.exit(1);
};

function startServer() {
  spawn(BIN, ["-js", "-sd", DIR, "-p", "4222"], { detached: true, stdio: "ignore" }).unref();
}
function killServer() {
  try {
    execFileSync("pkill", ["-x", "nats-server"]);
  } catch {
    /* already gone */
  }
}

async function open() {
  const nc = await connect({ servers: URL });
  return { nc, jsm: (await jetstreamManager(nc)) as any, js: (await jetstream(nc)) as any };
}

// --- phase 1: commit a lineage with a deadline, then arm it -------------------
let { nc, jsm, js } = await open();
try {
  await jsm.streams.delete(S);
} catch {}
await jsm.streams.add(resonateStreamConfig(S, LOG, TM, TK));

const mkLog = (js: any, jsm: any) => new JetStreamLog(jetStreamLogBinding(js, jsm, S), LOG);
const mkTimers = (js: any, jsm: any) =>
  new JetStreamTimerService({ binding: jetStreamTimerBinding(js, jsm, S), timerPrefix: TM, tickPrefix: TK });

const now = Date.now();
const deadline = now + 12_000;
{
  const runtime = new OriginRuntime({
    log: mkLog(js, jsm),
    timers: mkTimers(js, jsm),
    transport: new CollectingTransport(),
  });
  await runtime.apply(now, {
    kind: "promise.create",
    head: { corrId: "c", version: "v" },
    data: { id: "survivor", timeoutAt: deadline, param: { data: "payload" }, tags: {} },
  } as any);
  const armed = await mkTimers(js, jsm).deadline("survivor");
  if (armed === undefined) fail("no deadline armed");
  console.log(`armed survivor for ${new Date(deadline).toISOString()} (broker has it)`);
}
await nc.close();

// --- phase 2: total broker loss, deadline passes while down ------------------
killServer();
await sleep(2000);
console.log("nats-server killed; sleeping past the deadline with NOTHING running...");
await sleep(14_000);
console.log("deadline passed while down. restarting...");
startServer();
await sleep(4000);

// --- phase 3: did the timer fire, and did state survive? --------------------
({ nc, jsm, js } = await open());
const timers = mkTimers(js, jsm);
const log = mkLog(js, jsm);

const tick = await jsm.streams.getMessage(S, { last_by_subj: timers.tickSubject("survivor") }).catch(() => null);
if (!tick) fail("timer did NOT fire across the restart — lineage would be dead");
const origin = originFromScheduler(tick.header.get(SCHEDULER_HEADER), TM);
if (origin !== "survivor") fail(`tick names the wrong lineage: ${origin}`);
console.log("OK  timer fired across total broker loss, tick names:", origin);

const runtime = new OriginRuntime({ log, timers, transport: new CollectingTransport() });
const before = snapshot(await runtime.inspect("survivor"));
if (before.promises.survivor?.param?.data !== "payload") fail("committed state did not survive");
console.log("OK  committed state survived the restart");

const fired = await runtime.tick(origin!, Date.now());
if (fired === 0) fail("tick produced no transition");
const after = snapshot(await runtime.inspect("survivor"));
if (after.promises.survivor.state !== "rejected_timedout")
  fail(`expected rejected_timedout, got ${after.promises.survivor.state}`);
console.log("OK  processing the tick settled the promise:", after.promises.survivor.state);

// A lineage with nothing left to do must hold no deadline.
if ((await runtime.inspect("survivor")).nextDue() !== undefined) fail("deadline still armed after settlement");
console.log("OK  no deadline remains once the lineage is idle");

await nc.close();
console.log("\nPASS: liveness survived total broker loss with zero processes running.");
