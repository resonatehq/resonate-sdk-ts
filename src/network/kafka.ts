import { randomUUID, type UUID } from "node:crypto";
import type { KafkaJS } from "@confluentinc/kafka-javascript";
import type { ResonateError, ResonateServerError } from "../exceptions";
import exceptions from "../exceptions";
import * as util from "../util";
import type { Message, MessageSource, Network, Request, Response, ResponseFor } from "./network";

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
  private clientId: UUID;
  private pendingRequests: Map<string, (err?: ResonateError, res?: Response) => void>;

  constructor({ kafka }: KafkaNetworkConfig) {
    this.requestTopic = "resonate.requests";
    this.replyTopic = "resonate.replies";
    this.clientId = randomUUID();
    this.pendingRequests = new Map();

    this.producer = kafka.producer();
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

    // Start consumer loop
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        await this.consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (Number(message.offset) + 1).toString(), // wtf
          },
        ]);

        const res: KafkaResponse = JSON.parse(message.value?.toString()!);
        if (res.target !== this.clientId) {
          return;
        }

        const callback = this.pendingRequests.get(res.correlationId);
        if (callback === undefined) {
          return;
        }
        if (res.error !== undefined) {
          callback(exceptions.SERVER_ERROR(res.error.message, true, res.error as ResonateServerError));
        } else {
          callback(undefined, res.response);
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
    console.log("sending", req);
    const correlationId = randomUUID();

    this.pendingRequests.set(correlationId, callback as (err?: ResonateError, res?: Response) => void);

    const { op, payload } = mapRequestToOperation(req);
    const kafkaRequest: KafkaRequest = {
      target: "resonate.server",
      replyTo: {
        topic: this.replyTopic,
        target: this.clientId.toString(),
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

function mapRequestToOperation(req: Request): { op: string; payload: any } {
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
          id: req.promiseId,
          promiseId: req.rootPromiseId,
          recv: req.recv,
          timeout: req.timeout,
        },
      };
    case "createSubscription":
      return { op: "promises.subscribe", payload: {} };
    case "searchPromises":
      return { op: "promises.search", payload: {} };

    case "createSchedule":
      return { op: "schedules.create", payload: {} };
    case "readSchedule":
      return { op: "schedules.read", payload: {} };
    case "deleteSchedule":
      return { op: "schedules.delete", payload: {} };
    case "searchSchedules":
      return { op: "schedules.search", payload: {} };

    case "claimTask":
      return { op: "tasks.claim", payload: {} };
    case "completeTask":
      return { op: "tasks.complete", payload: {} };
    case "dropTask":
      return { op: "tasks.drop", payload: {} };
    case "heartbeatTasks":
      return { op: "tasks.heartbeat", payload: {} };
  }
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
            msg = { type: data.type, promise: data.promise, headers: data.head ?? {} };
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
