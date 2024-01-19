import { MemoryPromiseStorage, MemoryScheduleStorage } from "../lib/core/storages/memory";
import { LocalPromiseStore, LocalScheduleStore, LocalStore } from "../lib/core/stores/local";
import { describe, beforeEach, test, expect } from "@jest/globals";

describe("LocalPromiseStore", () => {
  let store: LocalStore;

  beforeEach(() => {
    const promiseStorage = new MemoryPromiseStorage();
    const scheduleStorage = new MemoryScheduleStorage();

    const promiseStore = new LocalPromiseStore(promiseStorage);
    const scheduleStore = new LocalScheduleStore(scheduleStorage);

    // Initialize a new LocalPromiseStore with a MemoryStorage for testing
    store = new LocalStore(promiseStore, scheduleStore);
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

    await store.schedules.create(
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

    // get the schedule
    const createdSchedule = await store.schedules.get(scheduleId);

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
    await store.schedules.create(
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

    // search for the schedule
    const searchResults = await store.schedules.get(scheduleId);
    expect(searchResults.id).toBe(scheduleId);

    const isDeleted = await store.schedules.delete(scheduleId);

    expect(isDeleted).toBe(true);

    // search for the schedule again
    const searchResultsAfterDelete = await store.schedules.search(scheduleId);
    expect(searchResultsAfterDelete.schedules.length).toBe(0);
  });

  test("searches for schedules", async () => {
    // Create multiple schedules for testing
    await store.schedules.create(
      "schedule-1",
      undefined,
      "Test Schedule",
      "* * * * *",
      { category: "search testing" },
      "promise-1",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    await store.schedules.create(
      "schedule-2",
      undefined,
      "Test Schedule",
      "* * * * *",
      { category: "search testing" },
      "promise-2",
      60000,
      {},
      '{"message": "Test"}',
      {},
    );

    const searchResults = await store.schedules.search("schedule-1", { category: "search testing" }, 10);

    // Expecting 1 schedules based on the search criteria
    expect(searchResults.schedules.length).toBe(1);
    expect(searchResults.schedules[0].id).toBe("schedule-1");
  });
});
