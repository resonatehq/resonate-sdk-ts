import { Schedule } from "../lib/core/schedule";
import { IStore } from "../lib/core/store";
import { LocalStore } from "../lib/core/stores/local";
import { describe, beforeEach, test, expect, jest } from "@jest/globals";
import { RemoteStore } from "../lib/core/stores/remote";
import { Logger } from "../lib/core/loggers/logger";

jest.setTimeout(10000);

describe("Schedule Store", () => {
  let store: IStore;
  const scheduleId = "schedule-1";
  const useDurable = process.env.USE_DURABLE === "true";

  beforeEach(() => {
    const url = process.env.RESONATE_URL || "http://localhost:8001";
    store = useDurable ? new RemoteStore(url, "", new Logger()) : new LocalStore();
  });

  test("Schedule Store: Create schedule", async () => {
    const scheduleId = "new-schedule";
    const cronExpression = "* * * * *"; // Every minute

    const createdSchedule = await store.schedules.create(
      scheduleId,
      scheduleId,
      "New Schedule",
      cronExpression,
      {},
      "promise-1",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    expect(createdSchedule.id).toBe(scheduleId);
    expect(createdSchedule.cron).toBe(cronExpression);
  });

  // this test needs to be discussed
  test("Schedule Store: Create schedule that exists with same idempotency key", async () => {
    const scheduleId = "existing-schedule";
    const cronExpression = "* * * * *"; // Every minute

    // Create the initial schedule
    await store.schedules.create(
      scheduleId,
      scheduleId,
      "Existing Schedule",
      cronExpression,
      {},
      "promise-1",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    // Attempt to create a schedule with the same idempotency key, should not throw error, rather return the existing schedule
    expect(
      await store.schedules.create(
        scheduleId,
        scheduleId,
        "Existing Schedule",
        cronExpression,
        {},
        "promise-1",
        60000,
        {},
        '{"message": "Test"}',
        {},
      ),
    ).toBeDefined();
  });

  test("Schedule Store: Create schedule that exists with different idempotency key", async () => {
    const scheduleId = "existing-schedule";
    const cronExpression = "* * * * *"; // Every minute

    // Create the initial schedule
    await store.schedules.create(
      scheduleId,
      scheduleId,
      "Existing Schedule",
      cronExpression,
      {},
      "promise-1",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    // Attempt to create a schedule with a different idempotency key, should throw error
    await expect(
      store.schedules.create(
        scheduleId,
        "new-idempotency-key",
        "New Schedule",
        cronExpression,
        {},
        "promise-1",
        60000,
        {},
        '{"message": "Test"}',
        {},
      ),
    ).rejects.toThrowError("Already exists");
  });

  test("Schedule Store: Get schedule that exists", async () => {
    const scheduleId = "existing-schedule";
    const cronExpression = "* * * * *"; // Every minute

    // Create the schedule
    await store.schedules.create(
      scheduleId,
      scheduleId,
      "Existing Schedule",
      cronExpression,
      {},
      "promise-1",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    // Get the existing schedule
    const existingSchedule = await store.schedules.get(scheduleId);
    expect(existingSchedule.id).toBe(scheduleId);
  });

  test("Schedule Store: Get schedule that does not exist", async () => {
    const nonExistingScheduleId = "non-existing-schedule-id";

    // Attempt to get a schedule that does not exist, should throw NOT_FOUND error
    await expect(store.schedules.get(nonExistingScheduleId)).rejects.toThrowError("Not found");
  });

  test("Schedule Store: Delete schedule that exists", async () => {
    const scheduleId = "schedule-to-delete";

    // Create the schedule first
    await store.schedules.create(
      scheduleId,
      scheduleId,
      "Existing Schedule",
      "* * * * *",
      {},
      "promise-1",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    // Attempt to delete the schedule
    const isDeleted = await store.schedules.delete(scheduleId);
    expect(isDeleted).toBeUndefined();

    // Attempt to get the deleted schedule, should throw NOT_FOUND error
    await expect(store.schedules.get(scheduleId)).rejects.toThrowError("Not found");
  });

  test("Schedule Store: Delete schedule that does not exist", async () => {
    const nonExistingScheduleId = "non-existing-schedule-id";

    // Attempt to delete a schedule that does not exist, should throw NOT_FOUND error
    await expect(store.schedules.delete(nonExistingScheduleId)).rejects.toThrowError("Not found");
  });
  test("Schedule Store: Search by id", async () => {
    const scheduleId = "search-by-id-schedule";

    // Create the schedule
    await store.schedules.create(
      scheduleId,
      scheduleId,
      "Search by ID Schedule",
      "* * * * *",
      {},
      "promise-1",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    // Search for the schedule by id
    let schedules: Schedule[] = [];
    for await (const searchResults of store.schedules.search(scheduleId, {})) {
      schedules = schedules.concat(searchResults);
    }
    expect(schedules.length).toBe(1);
    expect(schedules[0].id).toBe(scheduleId);
  });

  test("Schedule Store: Search by id with wildcard(s)", async () => {
    const scheduleIdPrefix = "search-by-id-prefix";
    const wildcardSearch = `${scheduleIdPrefix}*`;

    // Create multiple schedules with the same prefix
    for (let i = 1; i <= 3; i++) {
      await store.schedules.create(
        `${scheduleIdPrefix}-${i}`,
        `${scheduleIdPrefix}-${i}`,
        "Search by ID Prefix Schedule",
        "* * * * *",
        {},
        `promise-${i}`,
        60000,
        {},
        '{"message": "Test"}',
        {},
      );
    }

    // Search for schedules by id prefix with wildcard
    let schedules: Schedule[] = [];
    for await (const searchResults of store.schedules.search(wildcardSearch, {})) {
      schedules = schedules.concat(searchResults);
    }
    expect(schedules.length).toBe(3);
  });

  test("Schedule Store: Search by tags", async () => {
    const scheduleId = "search-by-tags-schedule";
    const tags = { category: "search testing", priority: "high" };

    // Create the schedule with specific tags
    await store.schedules.create(
      scheduleId,
      scheduleId,
      "Search by Tags Schedule",
      "* * * * *",
      tags,
      "promise-1",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    // Search for the schedule by tags
    let schedules: Schedule[] = [];
    for await (const searchResults of store.schedules.search(scheduleId, tags)) {
      schedules = schedules.concat(searchResults);
    }
    expect(schedules.length).toBe(1);
  });
});
