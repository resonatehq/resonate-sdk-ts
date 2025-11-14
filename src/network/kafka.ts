import { randomUUID, UUID } from "node:crypto";
import type { KafkaJS } from "@confluentinc/kafka-javascript";
import type { ResonateError, ResonateServerError } from "../exceptions";
import type { Value } from "../types";
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
import exceptions from "../exceptions";

// API Response Types (same as HttpNetwork)
interface PromiseDto {
  id: string;
  state: string;
  timeout: number;
  param?: Value<string>;
  value?: Value<string>;
  tags?: Record<string, string>;
  idempotencyKeyForCreate?: string;
  idempotencyKeyForComplete?: string;
  createdOn?: number;
  completedOn?: number;
}

interface TaskDto {
  id: string;
  rootPromiseId: string;
  counter: number;
  timeout: number;
  processId: string;
  createdOn?: number;
  completedOn?: number;
}

interface CallbackDto {
  id: string;
  promiseId: string;
  timeout: number;
  createdOn?: number;
}

interface ScheduleDto {
  id: string;
  description?: string;
  cron: string;
  tags?: Record<string, string>;
  promiseId: string;
  promiseTimeout: number;
  promiseParam?: Value<string>;
  promiseTags?: Record<string, string>;
  idempotencyKey?: string;
  lastRunTime?: number;
  nextRunTime?: number;
  createdOn?: number;
}

interface CreatePromiseAndTaskResponseDto {
  promise: PromiseDto;
  task?: TaskDto;
}

interface CallbackResponseDto {
  callback?: CallbackDto;
  promise: PromiseDto;
}

interface ClaimTaskResponseDto {
  type: string;
  promises: {
    root?: {
      id: string;
      href: string;
      data: PromiseDto;
    };
    leaf?: {
      id: string;
      href: string;
      data: PromiseDto;
    };
  };
}

interface HeartbeatResponseDto {
  tasksAffected: number;
}

interface SearchPromisesResponseDto {
  promises: PromiseDto[];
  cursor: string;
}

interface SearchSchedulesResponseDto {
  schedules: ScheduleDto[];
  cursor: string;
}

// Kafka Message Types
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
  success: boolean;
  response?: any;
  error?: {
    message: string;
    code: number;
  };
}

export interface KafkaNetworkConfig {
  kafka: KafkaJS.Kafka;
}

export class KafkaNetwork implements Network {
  private producer: KafkaJS.Producer;
  private consumer: KafkaJS.Consumer;
  private requestTopic: string;
  private replyTopic: string;
  private clientId: UUID
  private pendingRequests: Map<
    string,
    (err?: ResonateError, res?: Response) => void
  >;

  constructor({ kafka }: KafkaNetworkConfig) {
    this.requestTopic = "resonate.requests";
    this.replyTopic = "resonate.replies";
    this.clientId = randomUUID()
    this.pendingRequests = new Map();

    // Initialize producer
    this.producer = kafka.producer();

    // Initialize consumer
    this.consumer = kafka.consumer({
      "allow.auto.create.topics": true,
      "group.id": "groupId",
      "auto.offset.reset": "earliest",
      "enable.auto.commit": false,
    });
  }

  async start(): Promise<void> {
    // Connect producer
    await this.producer.connect();
    await this.consumer.connect();

    // Subscribe and start consuming
    await this.consumer.subscribe({ topic: this.replyTopic });

    // // Start consumer loop
    // this.consumerRunning = true;
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        await this.consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (Number(message.offset) + 1).toString(), // wtf
          },
        ]);

        const res: KafkaResponse = JSON.parse(message.value?.toString()!)
        if (res.target !== this.clientId) {
          return
        }

        const callback = this.pendingRequests.get(res.correlationId)
        if (callback === undefined){
          return
        }
        if (res.error !== undefined) {
          callback(exceptions.SERVER_ERROR(res.error.message, true, res.error as ResonateServerError))
        } else{
          callback(undefined, res.response)
        }

        this.pendingRequests.delete(res.correlationId)
      },
    });
  }

  async send<T extends Request>(
    req: T,
    callback: (err?: ResonateError, res?: ResponseFor<T>) => void,
    headers: Record<string, string> = {},
  ): Promise<void> {
    console.log("sending", req)
    const correlationId = randomUUID();

    this.pendingRequests.set(correlationId, callback as (err?: ResonateError, res?: Response) => void,);

    const kafkaRequest: KafkaRequest = {
      target: "resonate.server",
      replyTo: {
        topic: this.replyTopic,
        target: this.clientId.toString()
      },
      correlationId: correlationId,
      operation: mapRequestToOperation(req),
      payload: req,
    };


    try {
      await this.producer.send({ topic: this.requestTopic, messages: [{ value: JSON.stringify(kafkaRequest) }] });
    } catch (e) {
      console.log(e);
    }
  }

  public async stop(): Promise<void> {
    // this.consumerRunning = false;
    // // Clear all pending requests
    // for (const [_, { callback, timeoutId }] of this.pendingRequests) {
    //   clearTimeout(timeoutId);
    //   callback(exceptions.SERVER_ERROR("Network stopped"));
    // }
    // this.pendingRequests.clear();
    await this.consumer.disconnect();
    await this.producer.disconnect();
  }

  // private async handleResponse(message: any): Promise<void> {
  //   try {
  //     if (!message.value) return;

  //     const kafkaResponse: KafkaResponse = JSON.parse(message.value.toString());
  //     const pending = this.pendingRequests.get(kafkaResponse.correlationId);

  //     if (!pending) {
  //       if (this.verbose) {
  //         console.warn(`Received response for unknown correlation ID: ${kafkaResponse.correlationId}`);
  //       }
  //       return;
  //     }

  //     clearTimeout(pending.timeoutId);
  //     this.pendingRequests.delete(kafkaResponse.correlationId);

  //     if (!kafkaResponse.success) {
  //       const error = kafkaResponse.error;
  //       pending.callback(
  //         exceptions.SERVER_ERROR(error?.message || "Unknown error", error?.retriable, error as ResonateServerError),
  //       );
  //       return;
  //     }

  //     const response = this.deserializeResponse(pending.reqKind, kafkaResponse.payload);
  //     pending.callback(undefined, response);
  //   } catch (err) {
  //     console.error("Error handling Kafka response:", err);
  //   }
  // }

  private serializeRequest(req: Request): any {
    // Convert request to a serializable format
    switch (req.kind) {
      case "createPromise":
        return {
          id: req.id,
          timeout: req.timeout,
          param: req.param,
          tags: req.tags,
          iKey: req.iKey,
          strict: req.strict,
        };
      case "createPromiseAndTask":
        return {
          promise: {
            id: req.promise.id,
            timeout: req.promise.timeout,
            param: req.promise.param,
            tags: req.promise.tags,
          },
          task: {
            processId: req.task.processId,
            ttl: req.task.ttl,
          },
          iKey: req.iKey,
          strict: req.strict,
        };
      case "readPromise":
        return { id: req.id };
      case "completePromise":
        return {
          id: req.id,
          state: req.state,
          value: req.value,
          iKey: req.iKey,
          strict: req.strict,
        };
      case "createCallback":
        return {
          promiseId: req.promiseId,
          rootPromiseId: req.rootPromiseId,
          timeout: req.timeout,
          recv: req.recv,
        };
      case "createSubscription":
        return {
          id: req.id,
          promiseId: req.promiseId,
          timeout: req.timeout,
          recv: req.recv,
        };
      case "createSchedule":
        return {
          id: req.id,
          description: req.description,
          cron: req.cron,
          tags: req.tags,
          promiseId: req.promiseId,
          promiseTimeout: req.promiseTimeout,
          promiseParam: req.promiseParam,
          promiseTags: req.promiseTags,
          iKey: req.iKey,
        };
      case "readSchedule":
        return { id: req.id };
      case "deleteSchedule":
        return { id: req.id };
      case "claimTask":
        return {
          id: req.id,
          counter: req.counter,
          processId: req.processId,
          ttl: req.ttl,
        };
      case "completeTask":
        return {
          id: req.id,
          counter: req.counter,
        };
      case "dropTask":
        return {
          id: req.id,
          counter: req.counter,
        };
      case "heartbeatTasks":
        return { processId: req.processId };
      case "searchPromises":
        return {
          id: req.id,
          state: req.state,
          limit: req.limit,
          cursor: req.cursor,
        };
      case "searchSchedules":
        return {
          id: req.id,
          limit: req.limit,
          cursor: req.cursor,
        };
    }
  }

  private deserializeResponse(reqKind: string, payload: any): Response {
    switch (reqKind) {
      case "createPromise":
        return {
          kind: "createPromise",
          promise: mapPromiseDtoToRecord(payload.promise),
        };
      case "createPromiseAndTask":
        return {
          kind: "createPromiseAndTask",
          promise: mapPromiseDtoToRecord(payload.promise),
          task: payload.task ? mapTaskDtoToRecord(payload.task) : undefined,
        };
      case "readPromise":
        return {
          kind: "readPromise",
          promise: mapPromiseDtoToRecord(payload.promise),
        };
      case "completePromise":
        return {
          kind: "completePromise",
          promise: mapPromiseDtoToRecord(payload.promise),
        };
      case "createCallback":
        return {
          kind: "createCallback",
          callback: payload.callback ? mapCallbackDtoToRecord(payload.callback) : undefined,
          promise: mapPromiseDtoToRecord(payload.promise),
        };
      case "createSubscription":
        return {
          kind: "createSubscription",
          callback: payload.callback ? mapCallbackDtoToRecord(payload.callback) : undefined,
          promise: mapPromiseDtoToRecord(payload.promise),
        };
      case "createSchedule":
        return {
          kind: "createSchedule",
          schedule: mapScheduleDtoToRecord(payload.schedule),
        };
      case "readSchedule":
        return {
          kind: "readSchedule",
          schedule: mapScheduleDtoToRecord(payload.schedule),
        };
      case "deleteSchedule":
        return { kind: "deleteSchedule" };
      case "claimTask":
        return {
          kind: "claimTask",
          message: {
            kind: payload.message.kind,
            promises: {
              root: payload.message.promises.root
                ? {
                    id: payload.message.promises.root.id,
                    data: mapPromiseDtoToRecord(payload.message.promises.root.data),
                  }
                : undefined,
              leaf: payload.message.promises.leaf
                ? {
                    id: payload.message.promises.leaf.id,
                    data: mapPromiseDtoToRecord(payload.message.promises.leaf.data),
                  }
                : undefined,
            },
          },
        };
      case "completeTask":
        return {
          kind: "completeTask",
          task: mapTaskDtoToRecord(payload.task),
        };
      case "dropTask":
        return { kind: "dropTask" };
      case "heartbeatTasks":
        return {
          kind: "heartbeatTasks",
          tasksAffected: payload.tasksAffected,
        };
      case "searchPromises":
        return {
          kind: "searchPromises",
          promises: payload.promises,
          cursor: payload.cursor,
        };
      case "searchSchedules":
        return {
          kind: "searchSchedules",
          schedules: payload.schedules,
          cursor: payload.cursor,
        };
      default:
        throw new Error(`Unknown request kind: ${reqKind}`);
    }
  }
}

function mapRequestToOperation(req: Request): string {
  switch (req.kind) {
    case "createPromise":
      return "promises.create";
    case "createPromiseAndTask":
      return "promises.createtask";
    case "readPromise":
      return "promises.read";
    case "completePromise":
      return "promises.complete";
    case "createCallback":
      return "promises.callback";
    case "createSubscription":
      return "promises.subscribe";
    case "searchPromises":
      return "promises.search";

    case "createSchedule":
      return "schedules.create";
    case "readSchedule":
      return "schedules.read";
    case "deleteSchedule":
      return "schedules.delete";
    case "searchSchedules":
      return "schedules.search";

    case "claimTask":
      return "tasks.claim";
    case "completeTask":
      return "tasks.complete";
    case "dropTask":
      return "tasks.drop";
    case "heartbeatTasks":
      return "tasks.heartbeat";
  }
}

// Helper mapping functions (same as HttpNetwork)
function mapApiStateToInternal(
  state: string,
): "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout" {
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

function mapPromiseDtoToRecord(promise: PromiseDto): DurablePromiseRecord {
  return {
    id: promise.id,
    state: mapApiStateToInternal(promise.state),
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

function mapScheduleDtoToRecord(schedule: ScheduleDto): ScheduleRecord {
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

function mapCallbackDtoToRecord(apiCallback: CallbackDto): CallbackRecord {
  return {
    id: apiCallback.id,
    promiseId: apiCallback.promiseId,
    timeout: apiCallback.timeout,
    createdOn: apiCallback.createdOn,
  };
}

function mapTaskDtoToRecord(apiTask: TaskDto): TaskRecord {
  return {
    id: apiTask.id,
    rootPromiseId: apiTask.rootPromiseId,
    counter: apiTask.counter,
    timeout: apiTask.timeout,
    processId: apiTask.processId,
    createdOn: apiTask.createdOn,
    completedOn: apiTask.completedOn,
  };
}

export class KafkaMessageSource implements MessageSource {
  public readonly ready: Promise<void>;
  private consumer: KafkaJS.Consumer;
  private subscriptions: {
    invoke: Array<(msg: Message) => void>;
    resume: Array<(msg: Message) => void>;
    notify: Array<(msg: Message) => void>;
  } = { invoke: [], resume: [], notify: [] };

  constructor({ kafka }: { kafka: KafkaJS.Kafka }) {
    // Initialize consumer
    this.consumer = kafka.consumer({
      "allow.auto.create.topics": true,
      "group.id": "otherGroupId",
      "auto.offset.reset": "earliest",
      "enable.auto.commit": false,
    });

    this.ready = this.connect();
  }

  private async connect(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: "resonate.messages" });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        let msg: Message;

        try {
          const data = JSON.parse(message.value?.toString()!);

          if ((data?.type === "invoke" || data?.type === "resume") && util.isTaskRecord(data?.task)) {
            msg = { type: data.type, task: data.task, headers: data.head ?? {} };
          } else if (data?.type === "notify" && util.isDurablePromiseRecord(data?.promise)) {
            msg = { type: data.type, promise: mapPromiseDtoToRecord(data.promise), headers: data.head ?? {} };
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
