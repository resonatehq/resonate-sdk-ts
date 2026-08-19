/**
 * Tests for Source.match() — issue #499
 *
 * Each `Source` implementation must convert a plain target string (e.g.
 * "default") into a routable address. These tests verify that:
 *
 * 1. LocalConnection.match → `local://any@<target>`
 * 2. SseConnection.match   → `poll://any@<target>`
 */

import { SseConnection } from "@resonatehq/connector-http";
import { LocalConnection } from "../../src/connections/local.js";

// ---------------------------------------------------------------------------
// LocalConnection
// ---------------------------------------------------------------------------

describe("LocalConnection.match", () => {
  test("returns local://any@<target>", () => {
    const connection = new LocalConnection({ pid: "pid1", group: "grp" });
    expect(connection.match("my-group")).toBe("local://any@my-group");
  });

  test("uses the target argument, not the connection's own group", () => {
    const connection = new LocalConnection({ pid: "pid1", group: "own-group" });
    expect(connection.match("other-group")).toBe("local://any@other-group");
  });

  test("handles the default target string", () => {
    const connection = new LocalConnection();
    expect(connection.match("default")).toBe("local://any@default");
  });
});

// ---------------------------------------------------------------------------
// SseConnection
// ---------------------------------------------------------------------------

describe("SseConnection.match", () => {
  // SseConnection only connects on start(); constructing one is side-effect
  // free, so a dummy URL is fine — we only need the match method.
  function makeSse(group = "grp", pid = "pid1"): SseConnection {
    return new SseConnection({ url: "http://localhost:0", group, pid });
  }

  test("returns poll://any@<target>", () => {
    const source = makeSse();
    expect(source.match("my-group")).toBe("poll://any@my-group");
  });

  test("uses the target argument, not the source's own group", () => {
    const source = makeSse("own-group");
    expect(source.match("other-group")).toBe("poll://any@other-group");
  });

  test("handles the default target string", () => {
    const source = makeSse();
    expect(source.match("default")).toBe("poll://any@default");
  });

  test("derives identity and addresses from group/pid", () => {
    const source = makeSse("g1", "p1");
    expect(source.pid).toBe("p1");
    expect(source.group).toBe("g1");
    expect(source.unicast).toBe("poll://uni@g1/p1");
    expect(source.anycast).toBe("poll://any@g1/p1");
  });
});
