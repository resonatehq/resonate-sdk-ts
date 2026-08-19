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
// Connectors need `originOf` too: origin-partitioned transports (e.g. NATS)
// route a request to the server partition selected by the lineage origin of
// whatever id the request acts on.

/** Separates the origin from the lineage below it. A bare root joins its
 * first lineage segment with this. */
export const ORIGIN_SEP = ":";

/** Separates lineage segments below the origin. */
export const LINEAGE_SEP = ".";

/**
 * Append a lineage `segment` to `ancestor`.
 *
 * A bare root joins its *first* segment with `:`; an ancestor that already
 * carries lineage joins deeper segments with `.`, keeping the whole subtree
 * under one origin:
 *
 *   joinId("root", "1")     -> "root:1"
 *   joinId("root:1", "2")   -> "root:1.2"
 *   joinId("root:1.2", "3") -> "root:1.2.3"
 *
 * This is exactly the separator rule the server's `resonate:branch` /
 * `resonate:parent` validation applies.
 */
export function joinId(ancestor: string, segment: string): string {
  const sep = ancestor.includes(ORIGIN_SEP) ? LINEAGE_SEP : ORIGIN_SEP;
  return `${ancestor}${sep}${segment}`;
}

/**
 * The lineage origin of `id`: everything before the first `:`.
 *
 * Mirrors the server's `origin()`. An id with no lineage below it (a root) is
 * its own origin.
 */
export function originOf(id: string): string {
  const sep = id.indexOf(ORIGIN_SEP);
  return sep === -1 ? id : id.slice(0, sep);
}
