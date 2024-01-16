import { LocalPromiseStore } from "../lib/core/stores/local";
import { MemoryStorage } from "../lib/core/storages/memory";
import { describe, beforeEach, test, expect } from "@jest/globals";

describe("LocalPromiseStore", () => {
  let promiseStore: LocalPromiseStore;

  beforeEach(() => {
    // Initialize a new LocalPromiseStore with a MemoryStorage for testing
    promiseStore = new LocalPromiseStore(new MemoryStorage());
  });

  test("creates a schedule", async () => {
    const scheduleId = "schedule-1";
    const cronExpression = "* * * * *"; // Every minute
    const tags = { category: "testing" };
    const promiseId = "promise-1";
    const promiseTimeout = 60000; // 1 minute
    const promiseHeaders = { "Content-Type": "application/json" };
    const promiseData = '{"message": "Test"}';
    const promiseTags = { priority: "high" };

    const createdSchedule = await promiseStore.createSchedule(
      scheduleId,
      undefined,
      "Test Schedule",
      cronExpression,
      tags,
      promiseId,
      promiseTimeout,
      promiseHeaders,
      promiseData,
      promiseTags,
    );

    expect(createdSchedule.id).toBe(scheduleId);
    expect(createdSchedule.description).toBe("Test Schedule");
    expect(createdSchedule.cron).toBe(cronExpression);
    expect(createdSchedule.tags).toEqual(tags);
    expect(createdSchedule.promiseId).toBe(promiseId);
    expect(createdSchedule.promiseTimeout).toBe(promiseTimeout);
    expect(createdSchedule.promiseParam?.headers).toEqual(promiseHeaders);
    expect(createdSchedule.promiseParam?.data).toBe(promiseData);
    expect(createdSchedule.promiseTags).toEqual(promiseTags);
  });

  test("deletes a schedule", async () => {
    const scheduleId = "schedule-to-delete";

    // Create a schedule first
    await promiseStore.createSchedule(
      scheduleId,
      undefined,
      "Test Schedule",
      "* * * * *",
      {},
      "promise-1",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    const isDeleted = await promiseStore.deleteSchedule(scheduleId);

    expect(isDeleted).toBe(true);
  });

  test("searches for schedules", async () => {
    // Create multiple schedules for testing
    await promiseStore.createSchedule(
      "schedule-1",
      undefined,
      "Test Schedule",
      "* * * * *",
      { category: "testing" },
      "promise-1",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    await promiseStore.createSchedule(
      "schedule-2",
      undefined,
      "Test Schedule",
      "* * * * *",
      { category: "testing" },
      "promise-2",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    const searchResults = await promiseStore.searchSchedules("schedule-1", { category: "testing" }, 10);

    // Expecting 2 schedules based on the search criteria
    expect(searchResults.schedules.length).toBe(1);
    expect(searchResults.schedules[0].id).toBe("schedule-1");
  });
});
