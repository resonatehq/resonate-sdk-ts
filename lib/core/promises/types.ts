export type DurablePromise = PendingPromise | ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise;

export type PendingPromise = {
  state: "PENDING";
  id: string;
  timeout: number;
  param: {
    headers: Record<string, string> | undefined;
    data: string | undefined;
  };
  value: {
    headers: undefined;
    data: undefined;
  };
  createdOn: number;
  completedOn: undefined;
  idempotencyKeyForCreate: string | undefined;
  idempotencyKeyForComplete: undefined;
  tags: Record<string, string> | undefined;
};

export type ResolvedPromise = {
  state: "RESOLVED";
  id: string;
  timeout: number;
  param: {
    headers: Record<string, string> | undefined;
    data: string | undefined;
  };
  value: {
    headers: Record<string, string> | undefined;
    data: string | undefined;
  };
  createdOn: number;
  completedOn: number;
  idempotencyKeyForCreate: string | undefined;
  idempotencyKeyForComplete: string | undefined;
  tags: Record<string, string> | undefined;
};

export type RejectedPromise = {
  state: "REJECTED";
  id: string;
  timeout: number;
  param: {
    headers: Record<string, string> | undefined;
    data: string | undefined;
  };
  value: {
    headers: Record<string, string> | undefined;
    data: string | undefined;
  };
  createdOn: number;
  completedOn: number;
  idempotencyKeyForCreate: string | undefined;
  idempotencyKeyForComplete: string | undefined;
  tags: Record<string, string> | undefined;
};

export type CanceledPromise = {
  state: "REJECTED_CANCELED";
  id: string;
  timeout: number;
  param: {
    headers: Record<string, string> | undefined;
    data: string | undefined;
  };
  value: {
    headers: Record<string, string> | undefined;
    data: string | undefined;
  };
  createdOn: number;
  completedOn: number;
  idempotencyKeyForCreate: string | undefined;
  idempotencyKeyForComplete: string | undefined;
  tags: Record<string, string> | undefined;
};

export type TimedoutPromise = {
  state: "REJECTED_TIMEDOUT";
  id: string;
  timeout: number;
  param: {
    headers: Record<string, string> | undefined;
    data: string | undefined;
  };
  value: {
    headers: undefined;
    data: undefined;
  };
  createdOn: number;
  completedOn: number;
  idempotencyKeyForCreate: string | undefined;
  idempotencyKeyForComplete: undefined;
  tags: Record<string, string> | undefined;
};

// Type guards

export function isDurablePromise(p: unknown): p is DurablePromise {
  return (
    p !== null &&
    typeof p === "object" &&
    "state" in p &&
    typeof p.state === "string" &&
    ["PENDING", "RESOLVED", "REJECTED", "REJECTED_CANCELED", "REJECTED_TIMEDOUT"].includes(p.state)
  );
}

export function isPendingPromise(p: unknown): p is PendingPromise {
  return isDurablePromise(p) && p.state === "PENDING";
}

export function isResolvedPromise(p: unknown): p is ResolvedPromise {
  return isDurablePromise(p) && p.state === "RESOLVED";
}

export function isRejectedPromise(p: unknown): p is RejectedPromise {
  return isDurablePromise(p) && p.state === "REJECTED";
}

export function isCanceledPromise(p: unknown): p is CanceledPromise {
  return isDurablePromise(p) && p.state === "REJECTED_CANCELED";
}

export function isTimedoutPromise(p: unknown): p is TimedoutPromise {
  return isDurablePromise(p) && p.state === "REJECTED_TIMEDOUT";
}

export function isCompletedPromise(
  p: unknown,
): p is ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise {
  return isDurablePromise(p) && ["RESOLVED", "REJECTED", "REJECTED_CANCELED", "REJECTED_TIMEDOUT"].includes(p.state);
}
