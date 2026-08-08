// =============================================================================
// LIVE SUITE
// =============================================================================
//
// The same network, against a real S3 API over HTTP instead of MemoryBucket —
// the `awsBucket` driver's honesty (412/409 mapping, ETag plumbing, ordered
// listing, truncation) is what this suite exists to measure.
//
// Gated on an endpoint, so `npm test` stays hermetic:
//
//   S3_LIVE_ENDPOINT=http://127.0.0.1:9000 npx jest tests/s3.live.test.ts
//
// Anything speaking the S3 API with conditional writes works: MinIO, moto
// (`pip install moto[server]; moto_server -p 9000`), LocalStack, or AWS
// itself (leave S3_LIVE_ENDPOINT pointing at AWS and set real credentials,
// plus S3_LIVE_WORKFLOW_BUCKET / S3_LIVE_TIMEOUT_BUCKET to pre-created
// buckets — an Express directory bucket for workflows and a general purpose
// bucket for timeouts is the intended production shape).

import { afterAll, describe, expect, test } from "@jest/globals";
import { type Context, Resonate } from "../src/index.js";
import { awsBucket, minuteBucket, type S3Bucket, S3Network, workflowKey } from "../src/network/s3/index.js";
import type { Message, Request, Response } from "../src/network/types.js";
import { VERSION } from "../src/util.js";

const ENDPOINT = process.env.S3_LIVE_ENDPOINT;
const maybe = ENDPOINT ? describe : describe.skip;

let corr = 0;
function head(extra: Record<string, unknown> = {}) {
  corr += 1;
  return { corrId: `live${corr}`, version: VERSION, ...extra } as Request["head"];
}

const TARGET = "poll://any@default";

function ok<R extends Response>(res: R): Extract<R, { head: { status: 200 } }> {
  if (res.head.status < 200 || res.head.status >= 300) {
    throw new Error(`expected success, got ${res.head.status}: ${JSON.stringify(res.data)}`);
  }
  return res as Extract<R, { head: { status: 200 } }>;
}

function inbox(net: S3Network) {
  const messages: Message[] = [];
  net.recv((msg) => messages.push(msg));
  return {
    messages,
    async next(predicate: (msg: Message) => boolean, timeoutMs = 10_000): Promise<Message> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for message; saw ${JSON.stringify(messages)}`);
    },
  };
}

maybe("live s3", () => {
  const stamp = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const workflowBucketName = process.env.S3_LIVE_WORKFLOW_BUCKET ?? `resonate-live-wf-${stamp}`;
  const timeoutBucketName = process.env.S3_LIVE_TIMEOUT_BUCKET ?? `resonate-live-t-${stamp}`;
  // A per-run key prefix, so a shared long-lived bucket pair still gives each
  // run a clean namespace.
  const prefix = `run-${stamp}/`;

  let client: unknown;
  const opened: S3Network[] = [];

  async function setup(): Promise<{ workflows: S3Bucket; timeouts: S3Bucket }> {
    const sdk = await import("@aws-sdk/client-s3");
    if (!client) {
      client = new sdk.S3Client({
        endpoint: ENDPOINT,
        region: process.env.AWS_REGION ?? "us-east-1",
        forcePathStyle: true,
        credentials:
          process.env.AWS_ACCESS_KEY_ID === undefined ? { accessKeyId: "test", secretAccessKey: "test" } : undefined,
        maxAttempts: 1,
      });
      for (const bucket of new Set([workflowBucketName, timeoutBucketName])) {
        try {
          await (client as InstanceType<typeof sdk.S3Client>).send(new sdk.CreateBucketCommand({ Bucket: bucket }));
        } catch (err: unknown) {
          const name = (err as { name?: string }).name;
          if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
        }
      }
    }
    return {
      workflows: await awsBucket({ bucket: workflowBucketName, prefix, client }),
      timeouts: await awsBucket({ bucket: timeoutBucketName, prefix, client }),
    };
  }

  function track(net: S3Network): S3Network {
    opened.push(net);
    return net;
  }

  afterAll(async () => {
    while (opened.length > 0) await opened.pop()?.stop();
  });

  test("the protocol round-trips: create, acquire, fence, fulfill", async () => {
    const shared = await setup();
    const net = track(new S3Network({ ...shared, tickMs: 60_000 }));
    await net.init();
    const timeoutAt = Date.now() + 60_000;

    const created = ok(
      await net.send({
        kind: "promise.create",
        head: head(),
        data: { id: "wf", timeoutAt, param: { data: "in" }, tags: { "resonate:target": TARGET } },
      }),
    );
    expect(created.data.promise.state).toBe("pending");

    const acquired = ok(
      await net.send({ kind: "task.acquire", head: head(), data: { id: "wf", version: 0, pid: "p1", ttl: 30_000 } }),
    );
    expect(acquired.data.task.version).toBe(1);

    const fenced = ok(
      await net.send({
        kind: "task.fence",
        head: head(),
        data: {
          id: "wf",
          version: 1,
          action: {
            kind: "promise.create",
            head: head(),
            data: { id: "wf.child", timeoutAt, param: { data: "arg" }, tags: {} },
          },
        },
      }),
    );
    expect(fenced.data.action.head.status).toBe(200);

    const fulfilled = ok(
      await net.send({
        kind: "task.fulfill",
        head: head(),
        data: {
          id: "wf",
          version: 1,
          action: { kind: "promise.settle", head: head(), data: { id: "wf", state: "resolved", value: { data: 7 } } },
        },
      }),
    );
    expect(fulfilled.data.promise.state).toBe("resolved");

    const read = ok(await net.send({ kind: "promise.get", head: head(), data: { id: "wf" } }));
    expect(read.data.promise.value.data).toBe(7);
  });

  test("the coverage law holds on the wire: the wakeup entry is durable and time-bucketed", async () => {
    const shared = await setup();
    const net = track(new S3Network({ ...shared, tickMs: 60_000, retryTimeout: 120_000 }));
    await net.init();
    const now = Date.now();

    await net.send({
      kind: "promise.create",
      head: head({ "resonate:debug_time": now }),
      data: { id: "covered", timeoutAt: now + 300_000, param: {}, tags: { "resonate:target": TARGET } },
    });

    const listed = await shared.timeouts.list("t/");
    expect(listed.keys).toContain(`t/${minuteBucket(now + 120_000)}/o/covered`);
    expect((await shared.workflows.get(workflowKey("covered")))?.body).toContain('"covered"');
  });

  test("two processes racing one acquire through the real API produce exactly one winner", async () => {
    const shared = await setup();
    const a = track(new S3Network({ ...(await setup()), tickMs: 60_000 }));
    const b = track(new S3Network({ ...shared, tickMs: 60_000 }));
    await a.init();
    await b.init();

    ok(
      await a.send({
        kind: "promise.create",
        head: head(),
        data: { id: "race", timeoutAt: Date.now() + 60_000, param: {}, tags: { "resonate:target": TARGET } },
      }),
    );

    const [ra, rb] = await Promise.all([
      a.send({ kind: "task.acquire", head: head(), data: { id: "race", version: 0, pid: "pa", ttl: 30_000 } }),
      b.send({ kind: "task.acquire", head: head(), data: { id: "race", version: 0, pid: "pb", ttl: 30_000 } }),
    ]);
    expect([ra.head.status, rb.head.status].sort()).toEqual([200, 409]);
  });

  test("a second process discovers and claims work through the timeout bucket", async () => {
    const creator = track(new S3Network({ ...(await setup()), tickMs: 60_000, retryTimeout: 100 }));
    const worker = track(new S3Network({ ...(await setup()), tickMs: 25, retryTimeout: 100 }));
    await creator.init();
    await worker.init();
    const box = inbox(worker);

    ok(
      await creator.send({
        kind: "promise.create",
        head: head(),
        data: {
          id: "handoff",
          timeoutAt: Date.now() + 60_000,
          param: { data: "payload" },
          tags: { "resonate:target": TARGET },
        },
      }),
    );

    const swept = await box.next((m) => m.kind === "execute");
    expect(swept).toEqual({ kind: "execute", head: {}, data: { task: { id: "handoff", version: 0 } } });

    const acquired = ok(
      await worker.send({
        kind: "task.acquire",
        head: head(),
        data: { id: "handoff", version: 0, pid: "w1", ttl: 30_000 },
      }),
    );
    expect(acquired.data.promise.param.data).toBe("payload");
  }, 20_000);

  test("a generator workflow runs end to end over the wire", async () => {
    const resonate = new Resonate({ network: new S3Network({ ...(await setup()), tickMs: 25 }) });
    resonate.register("order", function* (ctx: Context, customer: string, amount: number): any {
      const ref = yield* ctx.run(async () => `CH-${amount}`);
      yield* ctx.sleep(50);
      return `${customer}:${ref}`;
    });
    try {
      expect(await resonate.run("live-order-1", "order", "acme", 42)).toBe("acme:CH-42");
    } finally {
      await resonate.stop();
    }
  }, 60_000);
});
