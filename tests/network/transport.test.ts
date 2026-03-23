import { describe, expect, test } from "@jest/globals";
import type { Network } from "../../src/network/network.js";
import type { Logger } from "../../src/logger.js";
import { buildTransport } from "../../src/util.js";
import { ResonateError } from "../../src/exceptions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A no-op Logger that suppresses all output. */
const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Stub Network whose `send` behavior is controlled per-test.
 * Only `send` is exercised by `buildTransport`; other methods are no-ops.
 */
function stubNetwork(sendImpl: (req: string) => Promise<string>): Network {
  return {
    pid: "test-pid",
    group: "test-group",
    unicast: "test-unicast",
    anycast: "test-anycast",
    start: async () => {},
    stop: async () => {},
    send: sendImpl,
    recv: () => {},
    match: () => "",
  };
}

/** Build a minimal valid PromiseGetReq. */
function makeRequest(corrId = "corr-1") {
  return {
    kind: "promise.get" as const,
    head: { corrId, version: "1.0.0" },
    data: { id: "p1" },
  };
}

/** Build a valid PromiseGetRes (404 variant — simplest, data is a string). */
function makeResponse(corrId = "corr-1") {
  return {
    kind: "promise.get" as const,
    head: { corrId, status: 404, version: "1.0.0" },
    data: "not found",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildTransport", () => {
  // -----------------------------------------------------------------------
  // 1. JSON round-trip: request is serialized, response is parsed
  // -----------------------------------------------------------------------
  test("request is JSON-serialized before sending, response is JSON-parsed", async () => {
    let captured: string | undefined;

    const network = stubNetwork(async (req: string) => {
      captured = req;
      // Echo back a valid response
      return JSON.stringify(makeResponse());
    });

    const transport = buildTransport(network, noopLogger);
    const req = makeRequest();
    const res = await transport.send(req);

    // The network received a JSON string, not an object
    expect(typeof captured).toBe("string");
    expect(JSON.parse(captured!)).toEqual(req);

    // The caller received a parsed object, not a string
    expect(typeof res).toBe("object");
    expect(res.kind).toBe("promise.get");
    expect(res.head.corrId).toBe("corr-1");
  });

  // -----------------------------------------------------------------------
  // 2. Mismatched `kind` throws SERVER_ERROR
  // -----------------------------------------------------------------------
  test("response with mismatched kind throws SERVER_ERROR", async () => {
    const network = stubNetwork(async () => {
      // Return a valid response but with wrong kind
      return JSON.stringify({
        kind: "promise.create",
        head: { corrId: "corr-1", status: 404, version: "1.0.0" },
        data: "not found",
      });
    });

    const transport = buildTransport(network, noopLogger);

    await expect(transport.send(makeRequest())).rejects.toThrow(ResonateError);
    await expect(transport.send(makeRequest())).rejects.toMatchObject({
      code: "99",
      type: "Server",
    });
  });

  // -----------------------------------------------------------------------
  // 3. Mismatched `corrId` throws SERVER_ERROR
  // -----------------------------------------------------------------------
  test("response with mismatched corrId throws SERVER_ERROR", async () => {
    const network = stubNetwork(async () => {
      return JSON.stringify({
        kind: "promise.get",
        head: { corrId: "wrong-corr-id", status: 404, version: "1.0.0" },
        data: "not found",
      });
    });

    const transport = buildTransport(network, noopLogger);

    await expect(transport.send(makeRequest())).rejects.toThrow(ResonateError);
    await expect(transport.send(makeRequest())).rejects.toMatchObject({
      code: "99",
      type: "Server",
    });
  });

  // -----------------------------------------------------------------------
  // 4. Malformed JSON response throws SERVER_ERROR
  // -----------------------------------------------------------------------
  test("malformed JSON response throws SERVER_ERROR", async () => {
    const network = stubNetwork(async () => {
      return "this is not json{{{";
    });

    const transport = buildTransport(network, noopLogger);

    await expect(transport.send(makeRequest())).rejects.toThrow(ResonateError);
    await expect(transport.send(makeRequest())).rejects.toMatchObject({
      code: "99",
      type: "Server",
      serverError: expect.objectContaining({
        code: 500,
        message: "Failed to parse response JSON",
      }),
    });
  });

  // -----------------------------------------------------------------------
  // 5. Network error is wrapped in SERVER_ERROR
  // -----------------------------------------------------------------------
  test("network error is wrapped in SERVER_ERROR", async () => {
    const network = stubNetwork(async () => {
      throw new Error("connection refused");
    });

    const transport = buildTransport(network, noopLogger);

    await expect(transport.send(makeRequest())).rejects.toThrow(ResonateError);
    await expect(transport.send(makeRequest())).rejects.toMatchObject({
      code: "99",
      type: "Server",
      retriable: true,
      serverError: expect.objectContaining({
        code: 500,
        message: "connection refused",
      }),
    });
  });
});
