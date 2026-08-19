import {
  assertNetwork,
  assertSource,
  getEnv,
  isSource,
  type Logger,
  type Network,
  type Source,
} from "@resonatehq/base";
import { HttpConnection } from "./http.js";
import { LocalConnection } from "./local.js";
import { SseConnection } from "./sse.js";

// =============================================================================
// Connection resolution
// =============================================================================
//
// Shared by both execution engines' `Resonate` constructors. A `Resonate`
// instance uses exactly one network and one or more sources:
//
// - `url`/`RESONATE_URL` -> `HttpConnection` + `[SseConnection]`; default ->
//   one `LocalConnection` as both. Precedence: url > network > env > local.
// - A dual-role connection passed as `network` without `sources` doubles as
//   the sole source — `new Resonate({ network: natsConn })` just works.
// - A dual-role connection passed only in `sources` uses its source half
//   exclusively (its `send` is never called).
// - `sources[0]` is the **primary source**: its `pid`/`group` are the SDK
//   identity, its `unicast` is advertised to `promise.register_listener`, and
//   its `match` mints `resonate:target` tags. Extra sources are additional
//   listening channels; duplicate delivery is safe (task acquire versioning,
//   idempotent subscription settle).
// - Guards fail fast: a send-only network without sources, sources without a
//   network, or `sources: []` throw an `Error`; an object not satisfying its
//   protocol throws a `TypeError` naming the missing members.

export interface ConnectionConfig {
  url?: string;
  group: string;
  pid: string;
  token?: string;
  timeout?: number;
  logger?: Logger;
  network?: Network;
  sources?: Source[];
}

export interface ResolvedConnections {
  network: Network;
  sources: [Source, ...Source[]];
  /** True when the SDK defaulted to the in-process local simulation. */
  local: boolean;
}

function http(url: string, cfg: ConnectionConfig): ResolvedConnections {
  const { group, pid, token, timeout, logger } = cfg;
  return {
    network: new HttpConnection({ url, token, timeout, logger }),
    sources: [new SseConnection({ url, group, pid, token, logger })],
    local: false,
  };
}

export function resolveConnections(cfg: ConnectionConfig): ResolvedConnections {
  const { url, network, sources } = cfg;

  // url wins over an explicit network; env is only consulted when neither is given.
  if (url) {
    return http(url, cfg);
  }

  if (network) {
    assertNetwork(network);

    if (sources !== undefined) {
      if (sources.length === 0) {
        throw new Error("sources must not be empty; omit sources to use a dual-role network as its own source");
      }
      for (const [i, s] of sources.entries()) {
        assertSource(s, `sources[${i}]`);
      }
      return { network, sources: sources as [Source, ...Source[]], local: false };
    }

    // A dual-role connection doubles as the sole source.
    if (!isSource(network)) {
      throw new Error(
        "network is send-only (it does not satisfy the Source protocol); provide at least one source via sources",
      );
    }
    return { network, sources: [network], local: false };
  }

  if (sources !== undefined) {
    throw new Error("sources require a network; pass network alongside sources");
  }

  const envUrl = getEnv("RESONATE_URL") || undefined;
  if (envUrl) {
    return http(envUrl, cfg);
  }

  const local = new LocalConnection({ pid: cfg.pid, group: cfg.group });
  return { network: local, sources: [local], local: true };
}

/** The distinct connections behind a network + sources, preserving order. */
export function uniqueConnections(connections: Array<Network | Source>): Array<Network | Source> {
  return [...new Set(connections)];
}
