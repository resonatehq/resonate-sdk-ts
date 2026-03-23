import { describe, expect, test, afterEach } from "@jest/globals";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { HttpNetwork } from "../../src/network/http.js";
import { ResonateError } from "../../src/exceptions.js";

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

  // Test: valid protocol responses are returned as typed Response objects
  // Status 200 requires proper data (object with promise field for promise.get)
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

  // Non-200 statuses use string data
  const nonSuccessProtocolStatuses = [404, 409, 422, 501];

  for (const status of nonSuccessProtocolStatuses) {
    test(`returns typed Response for HTTP ${status}`, async () => {
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

  // Test: timeout when server doesn't respond
  test("throws when server does not respond within timeout", async () => {
    const result = await createTestServer((_req, _res) => {
      // Intentionally never respond
    });
    server = result.server;

    const network = new HttpNetwork({
      url: `http://127.0.0.1:${result.port}`,
      timeout: 100,
    });

    await expect(network.send(makeRequest())).rejects.toThrow();
  });

  // Test: connection error when server is not listening
  test("throws when server is not listening (connection refused)", async () => {
    // Use a port that is very likely not in use
    const network = new HttpNetwork({
      url: "http://127.0.0.1:19999",
      timeout: 500,
    });

    await expect(network.send(makeRequest())).rejects.toThrow();
  });

  // Test: malformed JSON response throws SERVER_ERROR
  test("malformed JSON response throws SERVER_ERROR", async () => {
    const result = await createTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("this is not json{{{");
    });
    server = result.server;

    const network = new HttpNetwork({
      url: `http://127.0.0.1:${result.port}`,
      timeout: 500,
    });

    await expect(network.send(makeRequest())).rejects.toThrow(ResonateError);
    await expect(network.send(makeRequest())).rejects.toMatchObject({
      code: "99",
      type: "Server",
      serverError: expect.objectContaining({
        code: 500,
        message: "Failed to parse response JSON",
      }),
    });
  });

  // Test: response with mismatched kind throws SERVER_ERROR
  test("response with mismatched kind throws SERVER_ERROR", async () => {
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

    await expect(network.send(makeRequest())).rejects.toThrow(ResonateError);
  });

  // Test: response with mismatched corrId throws SERVER_ERROR
  test("response with mismatched corrId throws SERVER_ERROR", async () => {
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

    await expect(network.send(makeRequest())).rejects.toThrow(ResonateError);
  });

  // Test: network error is wrapped in SERVER_ERROR
  test("network error is wrapped in SERVER_ERROR", async () => {
    const network = new HttpNetwork({
      url: "http://127.0.0.1:19999",
      timeout: 500,
    });

    await expect(network.send(makeRequest())).rejects.toThrow(ResonateError);
    await expect(network.send(makeRequest())).rejects.toMatchObject({
      code: "99",
      type: "Server",
      retriable: true,
    });
  });

  // Test: non-protocol HTTP status codes -- the body is still parsed and validated
  // Since HttpNetwork now validates kind/corrId, if the body is a valid matching response
  // it will return it. Otherwise it throws.
  for (const status of [400, 500]) {
    test(`non-protocol HTTP ${status} with valid response body is parsed`, async () => {
      const responseBody = JSON.stringify({
        kind: "promise.get",
        head: { corrId: "corr-1", status, version: "1.0.0" },
        data: "error",
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

      // The response has matching kind and corrId, so it passes validation
      const response = await network.send(makeRequest());
      expect(response.kind).toBe("promise.get");
      expect(response.head.status).toBe(status);
    });
  }
});
