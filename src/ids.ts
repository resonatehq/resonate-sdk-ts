// The promise id format, in one place.
//
// The server treats a promise id as `<origin>:<lineage>`: the **origin** is
// everything before the first `:`, and the lineage segments below it are
// `.`-separated:
//
//   root -> root:1 -> root:1.1 -> root:1.1.1
//
// The origin is load-bearing. `promise.register_callback` and `task.suspend`
// require an awaiter and its awaited promise to share one, it selects the
// origin-state partition a request is routed to, and `promise.create` rejects
// an id that does not extend the `resonate:origin` / `resonate:branch` /
// `resonate:parent` it declares. So the SDK mints ids with `joinId` and reads
// them back with `originOf`, both of which mirror the server's own rules.
//
// A root id is supplied by the caller and becomes the origin of its whole
// lineage, so `validateRootId` keeps both separators out of it, exactly as the
// server does for the origin tag itself.

import exceptions from "./exceptions.js";

// `ORIGIN_SEP`/`LINEAGE_SEP`/`joinId`/`originOf` live in @resonatehq/base --
// connectors need them too (origin-partitioned transports route by lineage
// origin) -- and are re-exported here for the SDK's own modules.
export { joinId, LINEAGE_SEP, ORIGIN_SEP, originOf } from "@resonatehq/base";

import { LINEAGE_SEP, ORIGIN_SEP } from "@resonatehq/base";

/**
 * Validate a caller-supplied root id (`run` / `rpc` / `schedule` / an explicit
 * `options({ id })`), returning it.
 *
 * Both separators are **reserved**: a root becomes the origin of its whole
 * lineage, and the server rejects an origin containing either one outright
 * (`dot_in_origin` / `colon_in_origin`). `.` because it separates lineage
 * segments; `:` because the origin is everything before an id's *first* `:`,
 * so an origin holding one could never be split back out of any id.
 *
 * @throws {ResonateError} here, at the call site that named the workflow,
 *   rather than surfacing later as an opaque 400 from a background create.
 */
export function validateRootId(id: string): string {
  if (!id) {
    throw exceptions.INVALID_ID(id, "id must not be empty");
  }
  if (id.includes("\0")) {
    throw exceptions.INVALID_ID(id, "id must not contain null bytes");
  }
  for (const sep of [LINEAGE_SEP, ORIGIN_SEP]) {
    if (id.includes(sep)) {
      throw exceptions.INVALID_ID(
        id,
        `id must not contain '${sep}': it is reserved as a lineage separator in the ids the SDK mints below this one`,
      );
    }
  }
  return id;
}
