import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { ResonateError, ResonateServerError } from "../exceptions";
import exceptions from "../exceptions";
import * as util from "../util";
import type {
  CallbackRecord,
  DurablePromiseRecord,
  Message,
  MessageSource,
  Network,
  Request,
  Response,
  ResponseFor,
  ScheduleRecord,
  TaskRecord,
} from "./network";

interface KafkaRequest {
  target: string;
  replyTo: {
    topic: string;
    target: string;
  };
  correlationId: string;
  operation: string;
  payload: any;
}

interface KafkaResponse {
  target: string;
  correlationId: string;
  operation: string;
  success: boolean;
  response?: any;
  error?: {
    message: string;
    code: number;
  };
}

export class KafkaNetwork implements Network {
  private group: string;
  private pid: string;
  private requestTopic: string;
  private replyTopic: string;

  private producer: KafkaJS.Producer;
  private consumer: KafkaJS.Consumer;

  private pendingRequests: Map<string, (err?: ResonateError, res?: Response) => void>;

  constructor({
    group = "default",
    pid = crypto.randomUUID().replace(/-/g, ""),
  }: { group?: string; pid?: string } = {}) {
    const kafka = new KafkaJS.Kafka({
      kafkaJS: {
        clientId: pid,
        brokers: ["localhost:9092"],
        logLevel: 3,
      },
    });

    this.group = group;
    this.pid = pid;

    this.requestTopic = "resonate.requests";
    this.replyTopic = "resonate.replies";
    this.pendingRequests = new Map();

    this.producer = kafka.producer();
    this.consumer = kafka.consumer({
      "allow.auto.create.topics": true,
      "auto.offset.reset": "earliest", // this should probably be "lateset"
      "enable.auto.commit": true,
      "group.id": this.pid,
      "session.timeout.ms": 6000,
    });
  }

  async start(): Promise<void> {
    // Connect producer
    await this.producer.connect();
    await this.consumer.connect();

    // Subscribe and start consuming
    await this.consumer.subscribe({ topic: this.replyTopic });

    // Start consumer loop
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const res: KafkaResponse = JSON.parse(message.value?.toString()!);
        if (res.target !== this.pid) {
          return;
        }

        const callback = this.pendingRequests.get(res.correlationId);
        if (!callback) {
          return;
        }

        if (res.error) {
          callback(exceptions.SERVER_ERROR(res.error.message, true, res.error as ResonateServerError));
        } else {
          callback(undefined, mapKafkaResponseToResponse(res));
        }

        this.pendingRequests.delete(res.correlationId);
      },
    });
  }

  async send<T extends Request>(
    req: T,
    callback: (err?: ResonateError, res?: ResponseFor<T>) => void,
    headers: Record<string, string> = {},
  ): Promise<void> {
    const correlationId = crypto.randomUUID();

    this.pendingRequests.set(correlationId, callback as (err?: ResonateError, res?: Response) => void);

    const { op, payload } = mapRequestToKafkaRequest(req);
    const kafkaRequest: KafkaRequest = {
      target: "resonate.server",
      replyTo: {
        topic: this.replyTopic,
        target: this.pid,
      },
      correlationId: correlationId,
      operation: op,
      payload: payload,
    };

    try {
      await this.producer.send({ topic: this.requestTopic, messages: [{ value: JSON.stringify(kafkaRequest) }] });
    } catch (e) {
      console.log(e);
    }
  }

  public async stop(): Promise<void> {
    await this.consumer.disconnect();
    await this.producer.disconnect();
  }
}

function mapRequestToKafkaRequest(req: Request): { op: string; payload: any } {
  switch (req.kind) {
    case "createPromise":
      return {
        op: "promises.create",
        payload: {
          id: req.id,
          idempotencyKey: req.iKey,
          strict: req.strict,
          param: req.param,
          timeout: req.timeout,
          tags: req.tags,
        },
      };
    case "createPromiseAndTask":
      return {
        op: "promises.createtask",
        payload: {
          promise: {
            id: req.promise.id,
            idempotencyKey: req.iKey,
            strict: req.strict,
            param: req.promise.param,
            timeout: req.promise.timeout,
            tags: req.promise.tags,
          },
          task: {
            promiseId: req.promise.id,
            processId: req.task.processId,
            ttl: req.task.ttl,
            timeout: req.promise.timeout,
          },
        },
      };
    case "readPromise":
      return { op: "promises.read", payload: { id: req.id } };
    case "completePromise":
      return {
        op: "promises.complete",
        payload: {
          id: req.id,
          idempotencyKey: req.iKey,
          strict: req.strict,
          state: req.state,
          value: req.value,
        },
      };
    case "createCallback":
      return {
        op: "promises.callback",
        payload: {
          id: `__resume:${req.rootPromiseId}:${req.promiseId}`,
          promiseId: req.rootPromiseId,
          recv: req.recv,
          mesg: { type: "resume", head: {}, root: req.rootPromiseId, leaf: req.promiseId },
          timeout: req.timeout,
        },
      };
    case "createSubscription":
      return {
        op: "promises.subscribe",
        payload: {
          id: `__notify:${req.promiseId}:${req.id}`,
          promiseId: req.promiseId,
          recv: req.recv,
          mesg: { type: "notify", head: {}, root: req.promiseId },
          timeout: req.timeout,
        },
      };
    case "createSchedule":
      return {
        op: "schedules.create",
        payload: {
          id: req.id,
          description: req.description,
          cron: req.cron,
          tags: req.tags,
          promiseId: req.promiseId,
          promiseTimeout: req.promiseTimeout,
          promiseParam: req.promiseParam,
          promiseTags: req.promiseTags,
          idempotencyKey: req.iKey,
        },
      };
    case "readSchedule":
      return { op: "schedules.read", payload: { id: req.id } };
    case "searchSchedules":
      return { op: "schedules.search", payload: {} };
    case "deleteSchedule":
      return { op: "schedules.delete", payload: { id: req.id } };

    case "claimTask":
      return {
        op: "tasks.claim",
        payload: { id: req.id, counter: req.counter, processId: req.processId, ttl: req.ttl },
      };
    case "completeTask":
      return { op: "tasks.complete", payload: { id: req.id, counter: req.counter } };
    case "dropTask":
      return { op: "tasks.drop", payload: { id: req.id, counter: req.counter } };
    case "heartbeatTasks":
      return { op: "tasks.heartbeat", payload: { processId: req.processId } };
    default:
      throw new Error("unhandled");
  }
}

function mapKafkaResponseToResponse({ operation, response }: KafkaResponse): Response {
  switch (operation) {
    case "promises.create":
      return {
        kind: "createPromise",
        promise: convertPromise(response),
      };
    case "promises.createtask":
      return {
        kind: "createPromiseAndTask",
        promise: convertPromise(response.promise),
        task: response.task ? convertTask(response.task) : undefined,
      };
    case "promises.read":
      return {
        kind: "readPromise",
        promise: convertPromise(response),
      };
    case "promises.search":
      return {
        kind: "searchPromises",
        promises: (response.promises ?? []).map(convertPromise),
        cursor: response.cursor,
      };
    case "promises.complete":
      return {
        kind: "completePromise",
        promise: convertPromise(response),
      };
    case "promises.callback":
      return {
        kind: "createCallback",
        callback: response.callback ? convertCallback(response.callback) : undefined,
        promise: convertPromise(response.promise),
      };
    case "promises.subscribe":
      return {
        kind: "createSubscription",
        callback: response.callback ? convertCallback(response.callback) : undefined,
        promise: convertPromise(response.promise),
      };
    case "schedules.create":
      return {
        kind: "createSchedule",
        schedule: convertSchedule(response),
      };
    case "schedules.read":
      return {
        kind: "readSchedule",
        schedule: convertSchedule(response),
      };
    case "schedules.search":
      return {
        kind: "searchSchedules",
        schedules: (response.schedules ?? []).map(convertSchedule),
        cursor: response.cursor,
      };
    case "schedules.delete":
      return {
        kind: "deleteSchedule",
      };
    case "tasks.claim":
      return {
        kind: "claimTask",
        message: {
          kind: response.type,
          promises: {
            root: response.promises.root
              ? {
                  id: response.promises.root.id,
                  data: convertPromise(response.promises.root.data),
                }
              : undefined,
            leaf: response.promises.leaf
              ? {
                  id: response.promises.leaf.id,
                  data: convertPromise(response.promises.leaf.data),
                }
              : undefined,
          },
        },
      };
    case "tasks.complete":
      return {
        kind: "completeTask",
        task: convertTask(response),
      };
    case "tasks.drop":
      return {
        kind: "dropTask",
      };
    case "tasks.heartbeat":
      return {
        kind: "heartbeatTasks",
        tasksAffected: response.tasksAffected,
      };
    default:
      throw new Error("unhandled");
  }
}

export class KafkaMessageSource implements MessageSource {
  private group: string;
  private pid: string;

  private consumer: KafkaJS.Consumer;
  private subscriptions: {
    invoke: Array<(msg: Message) => void>;
    resume: Array<(msg: Message) => void>;
    notify: Array<(msg: Message) => void>;
  } = { invoke: [], resume: [], notify: [] };

  constructor({
    group = "default",
    pid = crypto.randomUUID().replace(/-/g, ""),
  }: { group?: string; pid?: string } = {}) {
    const kafka = new KafkaJS.Kafka({
      kafkaJS: {
        clientId: pid,
        brokers: ["localhost:9092"],
      },
    });

    this.group = group;
    this.pid = pid;

    this.consumer = kafka.consumer({
      "allow.auto.create.topics": true,
      "auto.offset.reset": "earliest",
      "enable.auto.commit": true,
      "group.id": this.group,
      "session.timeout.ms": 6000,
    });
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.group });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        let msg: Message;

        try {
          const data = JSON.parse(message.value?.toString() ?? "{}");

          if ((data?.type === "invoke" || data?.type === "resume") && util.isTaskRecord(data?.task)) {
            msg = { type: data.type, task: data.task, headers: data.head ?? {} };
          } else if (data?.type === "notify" && util.isDurablePromiseRecord(data?.promise)) {
            msg = { type: data.type, promise: convertPromise(data.promise), headers: data.head ?? {} };
          } else {
            throw new Error("invalid message");
          }
        } catch (e) {
          console.warn("Networking. Received invalid message. Will continue.");
          return;
        }

        this.recv(msg);
      },
    });
  }

  recv(msg: Message): void {
    for (const callback of this.subscriptions[msg.type]) {
      callback(msg);
    }
  }

  public stop(): void {
    this.consumer.disconnect();
  }

  public subscribe(type: "invoke" | "resume" | "notify", callback: (msg: Message) => void): void {
    this.subscriptions[type].push(callback);
  }
}

function convertPromise(promise: any): DurablePromiseRecord {
  return {
    id: promise.id,
    state: convertState(promise.state),
    timeout: promise.timeout,
    param: promise.param,
    value: promise.value,
    tags: promise.tags || {},
    iKeyForCreate: promise.idempotencyKeyForCreate,
    iKeyForComplete: promise.idempotencyKeyForComplete,
    createdOn: promise.createdOn,
    completedOn: promise.completedOn,
  };
}

function convertState(state: string): "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout" {
  switch (state) {
    case "PENDING":
      return "pending";
    case "RESOLVED":
      return "resolved";
    case "REJECTED":
      return "rejected";
    case "REJECTED_CANCELED":
      return "rejected_canceled";
    case "REJECTED_TIMEDOUT":
      return "rejected_timedout";
    default:
      throw new Error(`Unknown API state: ${state}`);
  }
}

function convertSchedule(schedule: any): ScheduleRecord {
  return {
    id: schedule.id,
    description: schedule.description,
    cron: schedule.cron,
    tags: schedule.tags || {},
    promiseId: schedule.promiseId,
    promiseTimeout: schedule.promiseTimeout,
    promiseParam: schedule.promiseParam,
    promiseTags: schedule.promiseTags || {},
    iKey: schedule.idempotencyKey,
    lastRunTime: schedule.lastRunTime,
    nextRunTime: schedule.nextRunTime,
    createdOn: schedule.createdOn,
  };
}

function convertCallback(callback: any): CallbackRecord {
  return {
    id: callback.id,
    promiseId: callback.promiseId,
    timeout: callback.timeout,
    createdOn: callback.createdOn,
  };
}

function convertTask(task: any): TaskRecord {
  return {
    id: task.id,
    rootPromiseId: task.rootPromiseId,
    counter: task.counter,
    timeout: task.timeout,
    processId: task.processId,
    createdOn: task.createdOn,
    completedOn: task.completedOn,
  };
}
