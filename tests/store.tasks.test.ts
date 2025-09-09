import { LocalNetwork } from "../dev/network";
import { Server } from "../dev/server";
import { Promises } from "../src/promises";
import { Tasks } from "../src/tasks";

let COUNTER = 0;
const TICK_TIME = 5;

describe("tasks transitions", () => {
  function step(server: Server): { id: string; counter: number } {
    const msgs = server.step(Date.now());
    expect(msgs.length).toBe(1);
    const value = msgs[0].msg;
    expect(value.type).toBe("invoke");
    if (value.type === "invoke") {
      return value.task as { id: string; counter: number };
    }
    throw new Error("unreachable path");
  }

  let server: Server;
  let network: LocalNetwork;
  let promises: Promises;
  let tasks: Tasks;
  let id: string;

  beforeAll(() => {
    server = new Server();
    network = new LocalNetwork(server);
    promises = new Promises(network);
    tasks = new Tasks(network);
  });

  beforeEach(async () => {
    id = `tid${COUNTER++}`;
    await promises.create({ id, timeout: Number.MAX_SAFE_INTEGER, tags: { "resonate:invoke": "default" } });
  });

  afterEach(async () => {
    await promises.resolve({ id });
  });

  test("Test Case 5: transition from enqueued to claimed via claim", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task5", ttl: Number.MAX_SAFE_INTEGER });
  });

  test("Test Case 6: transition from enqueue to enqueue via claim", async () => {
    const task = step(server);
    await expect(
      tasks.claim({ id: task.id, counter: task.counter + 1, processId: "task5", ttl: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow();
  });

  test("Test Case 8: transition from enqueue to enqueue via complete", async () => {
    const task = step(server);
    await expect(tasks.complete({ id: task.id, counter: task.counter })).rejects.toThrow();
  });

  test("Test Case 10: transition from enqueue to enqueue via heartbeat", async () => {
    const count = await tasks.heartbeat({ processId: "task10" });
    expect(count).toBe(0);
  });

  test("Test Case 12: transition from claimed to claimed via claim", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task12", ttl: Number.MAX_SAFE_INTEGER });
    await expect(
      tasks.claim({ id: task.id, counter: task.counter, processId: "task12", ttl: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow();
  });

  test("Test Case 13: transition from claimed to init via claim", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task13", ttl: 0 });
    await expect(
      tasks.claim({ id: task.id, counter: task.counter, processId: "task12", ttl: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow();
  });

  test("Test Case 14: transition from claimed to completed via complete", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task14", ttl: Number.MAX_SAFE_INTEGER });
    await tasks.complete({ id: task.id, counter: task.counter });
  });

  test("Test Case 15: transition from claimed to init via complete", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task15", ttl: 0 });
    await new Promise((r) => setTimeout(r, TICK_TIME));
    await expect(tasks.complete({ id: task.id, counter: task.counter })).rejects.toThrow();
  });

  test("Test Case 16: transition from claimed to claimed via complete", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task16", ttl: Number.MAX_SAFE_INTEGER });
    await expect(tasks.complete({ id: task.id, counter: task.counter + 1 })).rejects.toThrow();
  });

  test("Test Case 17: transition from claimed to init via complete (expired)", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task17", ttl: 0 });
    await new Promise((r) => setTimeout(r, TICK_TIME));
    await expect(tasks.complete({ id: task.id, counter: task.counter })).rejects.toThrow();
  });

  test("Test Case 18: transition from claimed to claimed via heartbeat", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task18", ttl: Number.MAX_SAFE_INTEGER });
    const count = await tasks.heartbeat({ processId: "task18" });
    expect(count).toBe(1);
  });

  test("Test Case 19: transition from claimed to init via heartbeat", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task19", ttl: 1000 });
    const count = await tasks.heartbeat({ processId: "task19" });
    expect(count).toBe(1);
  });

  test("Test Case 20: transition from completed to completed via claim", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task20", ttl: Number.MAX_SAFE_INTEGER });
    await tasks.complete({ id: task.id, counter: task.counter });
    await expect(tasks.claim({ id: task.id, counter: task.counter, processId: "task20", ttl: 0 })).rejects.toThrow();
  });

  test("Test Case 21: transition from completed to completed via complete", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task21", ttl: Number.MAX_SAFE_INTEGER });
    await tasks.complete({ id: task.id, counter: task.counter });
    await tasks.complete({ id: task.id, counter: task.counter });
  });

  test("Test Case 22: transition from completed to completed via heartbeat", async () => {
    const task = step(server);
    await tasks.claim({ id: task.id, counter: task.counter, processId: "task22", ttl: Number.MAX_SAFE_INTEGER });
    await tasks.complete({ id: task.id, counter: task.counter });
    const count = await tasks.heartbeat({ processId: "task22" });
    expect(count).toBe(0);
  });
});
