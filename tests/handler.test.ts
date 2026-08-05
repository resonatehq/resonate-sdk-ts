import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Core as AsyncCore } from "../src/async/core.js";
import { ResonateHandler } from "../src/handler.js";

/**
 * A stand-in Resonate server. Records every request it receives and answers
 * with whatever the test queued, so a test can assert on what the handler
 * *sent* rather than only on what it returned.
 */
class StubServer {
  private server: Server;
  public readonly received: any[] = [];
  public reply: (body: any) => { status: number; data: any } = () => ({
    status: 400,
    data: "stub has no reply",
  });

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<StubServer> {
    let stub: StubServer;
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        const body = JSON.parse(raw);
        stub.received.push(body);
        const { status, data } = stub.reply(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            kind: body.kind,
            head: { corrId: body.head?.corrId ?? "", status, version: body.head?.version ?? "" },
            data,
          }),
        );
      });
    });
    stub = new StubServer(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return stub;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const execute = (id: string, version: number, serverUrl?: string) =>
  new Request("https://fn.example.com/resonate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "execute",
      head: serverUrl ? { serverUrl } : {},
      data: { task: { id, version } },
    }),
  });

describe("ResonateHandler.handle", () => {
  describe("rejects what it cannot execute", () => {
    const handler = new ResonateHandler();

    test("a GET is 405 — this endpoint only receives pushes", async () => {
      const res = await handler.handle(new Request("https://fn.example.com/resonate"));
      expect(res.status).toBe(405);
    });

    test("a non-JSON body is 400, not a 500", async () => {
      const res = await handler.handle(
        new Request("https://fn.example.com/resonate", { method: "POST", body: "not json" }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/JSON/);
    });

    test("a well-formed message that is not `execute` is 400", async () => {
      // `unblock` is addressed to a listener waiting on a promise, not to a
      // worker holding a task. There is nothing here to acquire.
      const res = await handler.handle(
        new Request("https://fn.example.com/resonate", {
          method: "POST",
          body: JSON.stringify({ kind: "unblock", head: {}, data: { promise: {} } }),
        }),
      );
      expect(res.status).toBe(400);
    });

    test("an execute missing task.version is 400", async () => {
      const res = await handler.handle(
        new Request("https://fn.example.com/resonate", {
          method: "POST",
          body: JSON.stringify({ kind: "execute", head: {}, data: { task: { id: "wf" } } }),
        }),
      );
      expect(res.status).toBe(400);
    });

    test("every rejection is JSON", async () => {
      const res = await handler.handle(new Request("https://fn.example.com/resonate"));
      expect(res.headers.get("content-type")).toBe("application/json");
    });
  });

  describe("answers the server that pushed", () => {
    let stub: StubServer;
    beforeEach(async () => {
      stub = await StubServer.start();
    });
    afterEach(async () => {
      await stub.stop();
    });

    test("acquires the task named in the message, at its version", async () => {
      const handler = new ResonateHandler();
      await handler.handle(execute("wf.1", 3, stub.url));

      expect(stub.received).toHaveLength(1);
      expect(stub.received[0]).toMatchObject({
        kind: "task.acquire",
        data: { id: "wf.1", version: 3 },
      });
    });

    test("head.serverUrl wins over the constructor's url", async () => {
      // The server that pushed is the one holding the task; a configured url
      // is a fallback for messages that carry none, never an override.
      const wrong = await StubServer.start();
      const handler = new ResonateHandler({ url: wrong.url });
      await handler.handle(execute("wf", 1, stub.url));

      expect(stub.received).toHaveLength(1);
      expect(wrong.received).toHaveLength(0);
      await wrong.stop();
    });

    test("falls back to the constructor's url when the message carries none", async () => {
      const handler = new ResonateHandler({ url: stub.url });
      await handler.handle(execute("wf", 1));

      expect(stub.received).toHaveLength(1);
    });

    test("presents the configured ttl as the lease it can hold", async () => {
      // A pushed invocation cannot heartbeat, so the ttl is the only thing
      // keeping the task from being reclaimed underneath it.
      const handler = new ResonateHandler({ ttl: 90_000, pid: "w1" });
      await handler.handle(execute("wf", 1, stub.url));

      expect(stub.received[0].data).toMatchObject({ ttl: 90_000, pid: "w1" });
    });

    test("a server that refuses the claim is a 500, not a silent success", async () => {
      stub.reply = () => ({ status: 403, data: "already claimed" });
      const handler = new ResonateHandler();
      const res = await handler.handle(execute("wf", 1, stub.url));

      expect(res.status).toBe(500);
    });

    test("drives the async engine when given it", async () => {
      // The two engines expose the same constructor and the same onMessage, so
      // `handle` holds either without knowing which — the reason this file is
      // not duplicated per engine.
      const handler = new ResonateHandler({ engine: AsyncCore });
      await handler.handle(execute("wf", 2, stub.url));

      expect(stub.received[0]).toMatchObject({
        kind: "task.acquire",
        data: { id: "wf", version: 2 },
      });
    });
  });
});
