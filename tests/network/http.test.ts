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

describe("HttpNetwork.send()", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  // Test: valid protocol responses are returned as strings
  const protocolStatuses = [200, 300, 404, 409, 422, 501];

  for (const status of protocolStatuses) {
    test(`returns response body as string for HTTP ${status}`, async () => {
      const responseBody = JSON.stringify({ kind: "test", status });

      const result = await createTestServer((_req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(responseBody);
      });
      server = result.server;

      const network = new HttpNetwork({
        url: `http://127.0.0.1:${result.port}`,
        timeout: 500,
      });

      const response = await network.send('{"kind":"test"}');
      expect(response).toBe(responseBody);
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

    await expect(network.send('{"kind":"test"}')).rejects.toThrow();
  });

  // Test: connection error when server is not listening
  test("throws when server is not listening (connection refused)", async () => {
    // Use a port that is very likely not in use
    const network = new HttpNetwork({
      url: "http://127.0.0.1:19999",
      timeout: 500,
    });

    await expect(network.send('{"kind":"test"}')).rejects.toThrow();
  });

  // Test: non-protocol HTTP status codes (400, 500, etc.)
  // Documents CURRENT behavior: the response body is returned as-is regardless of status code.
  // HttpNetwork.send() does not distinguish between protocol and non-protocol statuses.
  const nonProtocolStatuses = [400, 401, 403, 429, 500, 502, 503];

  for (const status of nonProtocolStatuses) {
    test(`returns response body as string for non-protocol HTTP ${status} (current behavior)`, async () => {
      const responseBody = JSON.stringify({ error: "something went wrong" });

      const result = await createTestServer((_req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(responseBody);
      });
      server = result.server;

      const network = new HttpNetwork({
        url: `http://127.0.0.1:${result.port}`,
        timeout: 500,
      });

      const response = await network.send('{"kind":"test"}');
      expect(response).toBe(responseBody);
    });
  }
});
