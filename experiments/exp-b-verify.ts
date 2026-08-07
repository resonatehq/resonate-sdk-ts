// After a remoteWrites double-win, ask the remote who actually holds the task.
// One race, then a fresh replica reads the task row straight off the cloud.
//
// Run from resonate-sdk-ts:
//   npx tsx experiments/exp-b-verify.ts

import { mkdirSync, rmSync } from "node:fs";
import { ConsoleLogger } from "../src/index.js";
import { type TursoDriver, TursoNetwork, tursoSyncDriver } from "../src/network/turso/index.js";
import type { Request } from "../src/network/types.js";
import { VERSION } from "../src/util.js";

const TOKEN = process.env.TURSO_GROUP_TOKEN;
const ORG = process.env.TURSO_ORG;
const REGION = process.env.TURSO_REGION ?? "aws-us-west-2";
if (!TOKEN || !ORG) throw new Error("need TURSO_GROUP_TOKEN and TURSO_ORG");

const url = (name: string) => `libsql://${name}-${ORG}.${REGION}.turso.io`;
const base = "/tmp/turso-exp-b-verify";
rmSync(base, { recursive: true, force: true });

function syncDriver(dir: string, remoteWrites: boolean): TursoDriver {
  mkdirSync(dir, { recursive: true });
  return tursoSyncDriver({ dir, url, authToken: TOKEN, remoteWrites });
}

let corr = 0;
const head = () => ({ corrId: `v${++corr}`, version: VERSION }) as Request["head"];

function makeNet(dir: string, pid: string): TursoNetwork {
  return new TursoNetwork({
    driver: syncDriver(dir, true),
    prefix: "expb1-",
    timeoutDatabase: "timeouts",
    pid,
    tickMs: 3_600_000,
    retryTimeout: 3_600_000,
    pushOn: "request",
    logger: new ConsoleLogger("warn"),
  });
}

const id = `race.verify${Date.now().toString(36)}`;
const net0 = makeNet(`${base}/n0`, "n0");
await net0.init();
const created: any = await net0.send({
  kind: "promise.create",
  head: head(),
  data: { id, timeoutAt: Date.now() + 3_600_000, param: {}, tags: { "resonate:target": "poll://any@default" } },
});
console.log(`create -> ${created.head.status}`);

const net1 = makeNet(`${base}/n1`, "n1");
await net1.init();

const acquire = (net: TursoNetwork, pid: string) =>
  net
    .send({ kind: "task.acquire", head: head(), data: { id, version: 0, pid, ttl: 3_600_000 } })
    .then((r: any) => ({ pid, status: r.head.status, task: r.data?.task }))
    .catch((e) => ({ pid, status: `ERR:${e}`, task: undefined }));

const [a0, a1] = await Promise.all([acquire(net0, "n0"), acquire(net1, "n1")]);
for (const a of [a0, a1]) console.log(`${a.pid}: status=${a.status} version=${a.task?.version} state=${a.task?.state}`);

await net0.stop();
await net1.stop();

// The remote's verdict, via a brand-new replica that bootstraps from the cloud.
const observer = await syncDriver(`${base}/observer`, false).open("expb1-race");
await observer.pull?.();
const rows = await observer.execute("SELECT id, version, state, pid FROM tasks WHERE id = ?", [id]);
console.log(`remote task row: ${JSON.stringify(rows)}`);
await observer.close();
process.exit(0);
