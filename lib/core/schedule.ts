export type Schedule = {
  id: string;
  description?: string;
  cron: string;
  tags?: Record<string, string>;
  promiseId: string;
  promiseTimeout: number;
  promiseParam?: PromiseValue;
  promiseTags?: Record<string, string>;
  lastRunTime?: number;
  nextRunTime?: number;
  idempotencyKey?: string;
  createdOn?: number;
};

export type PromiseValue = {
  data?: string;
  headers: Record<string, string>;
};
