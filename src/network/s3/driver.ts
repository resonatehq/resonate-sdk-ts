// =============================================================================
// DRIVER
// =============================================================================
//
// The decentralized network needs exactly four things from object storage:
// read a key, write a key conditionally, delete a key, and list keys in
// lexicographic order. That is the whole contract, expressed below as
// `S3Bucket`.
//
// Two buckets back the network, and they want different bucket classes:
//
//   WORKFLOW bucket — one document per workflow, addressed by key, never
//   listed on the hot path. Conditional PUT (`If-None-Match: *` / `If-Match`)
//   is the entire concurrency model. An S3 Express One Zone directory bucket
//   is the right home: single-digit-millisecond latency, high TPS, and the
//   conditional-write API is identical — Express is a bucket choice, not a
//   code path.
//
//   TIMEOUT bucket — one small document per armed wakeup, keyed by time
//   bucket. The sweeper LISTs this bucket and depends on lexicographic key
//   order to read entries oldest-first and stop at `now` — which is why this
//   must be a GENERAL PURPOSE bucket: `ListObjectsV2` returns keys in
//   ascending UTF-8 order there, while a directory bucket's listing order is
//   unspecified. Ordering is the feature; Express would break it.
//
// The conditional-write fault model is the one the kernel-owned-retries rule
// exists for: a transparently retried conditional PUT whose first attempt
// landed answers 412 to the retry, converting "may have committed" into a
// false rejection. The AWS driver therefore disables SDK retries on the CAS
// path and reports the backend's own answer; ambiguity (network error after
// the request may have reached the store) surfaces as `"unknown"`, and the
// store's update loop resolves it by re-reading and recognizing its own bytes.

/** A stored object: its body and the version tag the store reported. */
export interface S3Object {
  body: string;
  etag: string;
}

/**
 * The write condition. `create` = the key must not exist (`If-None-Match: *`);
 * `{ ifMatch }` = the key must still carry this ETag (`If-Match`). There is no
 * unconditional PUT — every write is a compare-and-swap.
 */
export type PutCondition = { kind: "create" } | { kind: "replace"; ifMatch: string };

/**
 * What a conditional PUT reports.
 *
 *   `landed`   — the store accepted exactly this attempt; `etag` names it.
 *   `conflict` — the store's own answer to exactly this attempt: the
 *                condition failed (412), or a concurrent conditional write
 *                raced it (409), or the object vanished under an If-Match.
 *   `unknown`  — the attempt's fate is unknowable (network error after the
 *                bytes may have reached the store). Never folded into either
 *                of the above; the caller must re-read to find out.
 */
export type PutResult = { kind: "landed"; etag: string } | { kind: "conflict" } | { kind: "unknown"; error: string };

export interface S3Bucket {
  /** Read one key. `null` when it does not exist. */
  get(key: string): Promise<S3Object | null>;

  /** Conditionally write one key. See `PutResult` for the honesty contract. */
  put(key: string, body: string, condition: PutCondition): Promise<PutResult>;

  /** Delete one key. Deleting an absent key succeeds — S3 semantics. */
  delete(key: string): Promise<void>;

  /**
   * Keys under `prefix`, in ascending lexicographic (UTF-8 binary) order,
   * starting strictly after `startAfter` when given. `truncated` means more
   * keys follow the last one returned.
   *
   * The sweeper's correctness leans on the ordering: it stops reading at the
   * first key past `now`, so a bucket class that lists unordered (an S3
   * Express directory bucket) must not back the timeout bucket.
   */
  list(prefix: string, opts?: { startAfter?: string; limit?: number }): Promise<{ keys: string[]; truncated: boolean }>;
}

// =============================================================================
// MEMORY BUCKET
// =============================================================================

/**
 * The lock-atomic reference implementation: conditional semantics checked
 * under JavaScript's single-threaded execution, keys listed in sorted order.
 * What tests run against, and the contract the AWS driver must match.
 */
export class MemoryBucket implements S3Bucket {
  private readonly objects = new Map<string, S3Object>();
  private counter = 0;

  async get(key: string): Promise<S3Object | null> {
    const found = this.objects.get(key);
    return found ? { ...found } : null;
  }

  async put(key: string, body: string, condition: PutCondition): Promise<PutResult> {
    const existing = this.objects.get(key);
    if (condition.kind === "create" && existing) return { kind: "conflict" };
    if (condition.kind === "replace" && (!existing || existing.etag !== condition.ifMatch)) {
      return { kind: "conflict" };
    }
    const etag = `"v${++this.counter}"`;
    this.objects.set(key, { body, etag });
    return { kind: "landed", etag };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string, opts?: { startAfter?: string; limit?: number }) {
    const limit = opts?.limit ?? 1000;
    const all = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && (opts?.startAfter === undefined || k > opts.startAfter))
      .sort();
    return { keys: all.slice(0, limit), truncated: all.length > limit };
  }

  /** Test support: every key, sorted. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

// =============================================================================
// AWS BUCKET (@aws-sdk/client-s3)
// =============================================================================

export interface AwsBucketConfig {
  /** Bucket name — a directory bucket for workflows, general purpose for timeouts. */
  bucket: string;
  /** Key prefix inside the bucket, so several tenants can share one. Default "". */
  prefix?: string;
  region?: string;
  /** For S3-compatible stores (MinIO, R2, ...). */
  endpoint?: string;
  forcePathStyle?: boolean;
  /** A preconfigured S3Client; overrides region/endpoint/forcePathStyle. */
  client?: unknown;
}

/**
 * An `S3Bucket` over `@aws-sdk/client-s3` (an optional peer dependency,
 * imported dynamically so the SDK carries no hard dependency on it).
 *
 * The client is built with retries DISABLED: the update loop owns retry
 * semantics, and a transport that silently retries a conditional PUT can turn
 * its own success into a reported conflict. Pass a preconfigured `client`
 * only if its retry strategy keeps attempts = 1.
 */
export async function awsBucket(cfg: AwsBucketConfig): Promise<S3Bucket> {
  let sdk: any;
  try {
    sdk = await import("@aws-sdk/client-s3");
  } catch {
    throw new Error("awsBucket requires the optional dependency @aws-sdk/client-s3 — npm install @aws-sdk/client-s3");
  }
  const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = sdk;

  const client =
    cfg.client ??
    new S3Client({
      ...(cfg.region ? { region: cfg.region } : {}),
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      ...(cfg.forcePathStyle !== undefined ? { forcePathStyle: cfg.forcePathStyle } : {}),
      maxAttempts: 1,
    });
  const prefix = cfg.prefix ?? "";

  const statusOf = (err: any): number | undefined => err?.$metadata?.httpStatusCode;

  return {
    async get(key: string): Promise<S3Object | null> {
      try {
        const res = await (client as any).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: prefix + key }));
        const body = await res.Body.transformToString();
        if (typeof res.ETag !== "string") throw new Error(`GET ${key}: no ETag on a 200`);
        return { body, etag: res.ETag };
      } catch (err: any) {
        if (err?.name === "NoSuchKey" || statusOf(err) === 404) return null;
        throw err;
      }
    },

    async put(key: string, body: string, condition: PutCondition): Promise<PutResult> {
      try {
        const res = await (client as any).send(
          new PutObjectCommand({
            Bucket: cfg.bucket,
            Key: prefix + key,
            Body: body,
            ContentType: "application/json",
            ...(condition.kind === "create" ? { IfNoneMatch: "*" } : { IfMatch: condition.ifMatch }),
          }),
        );
        if (typeof res.ETag !== "string") return { kind: "unknown", error: `PUT ${key}: no ETag on a 200` };
        return { kind: "landed", etag: res.ETag };
      } catch (err: any) {
        const status = statusOf(err);
        // 412: the condition failed. 409: a concurrent conditional write raced
        // us. 404 under If-Match: the object vanished — for a REPLACE that is a
        // condition failure; a create's 404 can only be NoSuchBucket, which is
        // infrastructure, not a condition.
        if (status === 412 || status === 409 || (status === 404 && condition.kind === "replace")) {
          return { kind: "conflict" };
        }
        return { kind: "unknown", error: String(err) };
      }
    },

    async delete(key: string): Promise<void> {
      await (client as any).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: prefix + key }));
    },

    async list(key: string, opts?: { startAfter?: string; limit?: number }) {
      const res = await (client as any).send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: prefix + key,
          ...(opts?.startAfter !== undefined ? { StartAfter: prefix + opts.startAfter } : {}),
          MaxKeys: opts?.limit ?? 1000,
        }),
      );
      const keys = (res.Contents ?? [])
        .map((o: { Key?: string }) => o.Key ?? "")
        .filter((k: string) => k.startsWith(prefix))
        .map((k: string) => k.slice(prefix.length));
      return { keys, truncated: res.IsTruncated === true };
    },
  };
}
