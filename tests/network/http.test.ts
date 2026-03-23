import { describe, expect, test, afterEach } from "@jest/globals";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { HttpNetwork } from "../../src/network/http.js";

// Helper: create a local HTTP server that responds on /api
function createTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error("Failed to get server address"));
      }
    });
    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Build a minimal valid PromiseGetReq for testing. */
function makeRequest(corrId = "corr-1") {
  return {
    kind: "promise.get" as const,
    head: { corrId, version: "1.0.0" },
    data: { id: "p1" },
  };
}

describe("HttpNetwork.send()", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  // =========================================================================
  // Valid protocol responses — returned as-is
  // =========================================================================

  test("returns typed Response for HTTP 200", async () => {
    const responseBody = JSON.stringify({
      kind: "promise.get",
      head: { corrId: "corr-1", status: 200, version: "1.0.0" },
      data: {
        promise: {
          id: "p1",
          state: "pending",
          param: { headers: {}, data: "" },
          value: { headers: {}, data: "" },
          tags: {},
          timeoutAt: Date.now() + 60000,
          createdAt: Date.now(),
        },
      },
    });

    const result = await createTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(responseBody);
    });
    server = result.server;

    const network = new HttpNetwork({
      url: `http://127.0.0.1:${result.port}`,
      timeout: 500,
    });

    const response = await network.send(makeRequest());
    expect(typeof response).toBe("object");
    expect(response.kind).toBe("promise.get");
    expect(response.head.corrId).toBe("corr-1");
    expect(response.head.status).toBe(200);
  });

  // Non-200 protocol statuses
  const protocolStatuses = [404, 409, 422, 501];

  for (const status of protocolStatuses) {
    test(`returns typed Response for protocol HTTP ${status}`, async () => {
      const responseBody = JSON.stringify({
        kind: "promise.get",
        head: { corrId: "corr-1", status, version: "1.0.0" },
        data: "not found",
      });

      const result = await createTestServer((_req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(responseBody);
      });
      server = result.server;

      const network = new HttpNetwork({
        url: `http://127.0.0.1:${result.port}`,
        timeout: 500,
      });

      const response = await network.send(makeRequest());
      expect(typeof response).toBe("object");
      expect(response.kind).toBe("promise.get");
      expect(response.head.corrId).toBe("corr-1");
      expect(response.head.status).toBe(status);
    });
  }

  test("returns typed Response for protocol HTTP 300 (redirect)", async () => {
    const responseBody = JSON.stringify({
      kind: "promise.get",
      head: { corrId: "corr-1", status: 300, version: "1.0.0" },
      data: "redirect",
    });

    const result = await createTestServer((_req, res) => {
      res.writeHead(300, { "Content-Type": "application/json" });
      res.end(responseBody);
    });
    server = result.server;

    const network = new HttpNetwork({
      url: `http://127.0.0.1:${result.port}`,
      timeout: 500,
    });

    const response = await network.send(makeRequest());
    expect(response.kind).toBe("promise.get");
    expect(response.head.status).toBe(300);
  });

  // =========================================================================
  // Platform failures — collapsed to synthetic timeout response
  // =========================================================================

  test("returns synthetic timeout on server timeout (no response)", async () => {
    const result = await createTestServer((_req, _res) => {
      // Intentionally never respond
    });
    server = result.server;

    const network = new HttpNetwork({
      url: `http://127.0.0.1:${result.port}`,
      timeout: 100,
    });

    const response = await network.send(makeRequest());
    expect(response.kind).toBe("promise.get");
    expect(response.head.corrId).toBe("corr-1");
    expect(response.head.status).toBe(500);
    expect(response.data).toMatch(/^platform failure:/);
  });

  test("returns synthetic timeout on connection refused", async () => {
    // Use a port that is very likely not in use
    const network = new HttpNetwork({
      url: "http://127.0.0.1:19999",
      timeout: 500,
    });

    const response = await network.send(makeRequest());
    expect(response.kind).toBe("promise.get");
    expect(response.head.corrId).toBe("corr-1");
    expect(response.head.status).toBe(500);
    expect(response.data).toMatch(/^platform failure:/);
  });

  test("returns synthetic timeout on malformed JSON response", async () => {
    const result = await createTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("this is not json{{{");
    });
    server = result.server;

    const network = new HttpNetwork({
      url: `http://127.0.0.1:${result.port}`,
      timeout: 500,
    });

    const response = await network.send(makeRequest());
    expect(response.kind).toBe("promise.get");
    expect(response.head.corrId).toBe("corr-1");
    expect(response.head.status).toBe(500);
    expect(response.data).toMatch(/^platform failure:.*parse/i);
  });

  test("returns synthetic timeout on mismatched kind", async () => {
    const result = await createTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        kind: "promise.create",
        head: { corrId: "corr-1", status: 200, version: "1.0.0" },
        data: {},
      }));
    });
    server = result.server;

    const network = new HttpNetwork({
      url: `http://127.0.0.1:${result.port}`,
      timeout: 500,
    });

    const response = await network.send(makeRequest());
    expect(response.kind).toBe("promise.get");
    expect(response.head.status).toBe(500);
    expect(response.data).toMatch(/^platform failure:.*match/i);
  });

  test("returns synthetic timeout on mismatched corrId", async () => {
    const result = await createTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        kind: "promise.get",
        head: { corrId: "wrong-corr-id", status: 200, version: "1.0.0" },
        data: {},
      }));
    });
    server = result.server;

    const network = new HttpNetwork({
      url: `http://127.0.0.1:${result.port}`,
      timeout: 500,
    });

    const response = await network.send(makeRequest());
    expect(response.kind).toBe("promise.get");
    expect(response.head.status).toBe(500);
    expect(response.data).toMatch(/^platform failure:.*match/i);
  });

  // =========================================================================
  // Non-protocol HTTP status codes — platform failures
  // =========================================================================

  for (const status of [400, 401, 403, 429, 500, 503]) {
    test(`returns synthetic timeout for non-protocol HTTP ${status}`, async () => {
      const result = await createTestServer((_req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "server error" }));
      });
      server = result.server;

      const network = new HttpNetwork({
        url: `http://127.0.0.1:${result.port}`,
        timeout: 500,
      });

      const response = await network.send(makeRequest());
      expect(response.kind).toBe("promise.get");
      expect(response.head.corrId).toBe("corr-1");
      expect(response.head.status).toBe(500);
      expect(response.data).toMatch(new RegExp(`^platform failure:.*HTTP ${status}`));
    });
  }

  // =========================================================================
  // Classification: protocol vs platform
  // =========================================================================

  test("protocol statuses (200, 300, 404, 409, 422, 501) are returned, not collapsed", async () => {
    for (const status of [200, 300, 404, 409, 422, 501]) {
      const responseBody = status === 200
        ? JSON.stringify({
            kind: "promise.get",
            head: { corrId: "corr-1", status: 200, version: "1.0.0" },
            data: {
              promise: {
                id: "p1",
                state: "pending",
                param: { headers: {}, data: "" },
                value: { headers: {}, data: "" },
                tags: {},
                timeoutAt: Date.now() + 60000,
                createdAt: Date.now(),
              },
            },
          })
        : JSON.stringify({
            kind: "promise.get",
            head: { corrId: "corr-1", status, version: "1.0.0" },
            data: "protocol error",
          });

      const result = await createTestServer((_req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(responseBody);
      });

      const network = new HttpNetwork({
        url: `http://127.0.0.1:${result.port}`,
        timeout: 500,
      });

      const response = await network.send(makeRequest());
      expect(response.head.status).toBe(status);
      // data should NOT start with "platform failure:"
      if (typeof response.data === "string") {
        expect(response.data).not.toMatch(/^platform failure:/);
      }

      await closeServer(result.server);
    }
  });

  test("send never throws — all failures return synthetic timeout", async () => {
    // Connection refused
    const network = new HttpNetwork({
      url: "http://127.0.0.1:19999",
      timeout: 100,
    });

    // This should resolve, not reject
    const response = await network.send(makeRequest());
    expect(response).toBeDefined();
    expect(response.kind).toBe("promise.get");
    expect(response.head.status).toBe(500);
  });
});
