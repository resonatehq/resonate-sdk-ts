import { describe, test, expect, jest } from "@jest/globals";
import { IStore } from "../lib/core/store";
import { LocalStore } from "../lib/core/stores/local";
import { RemoteStore } from "../lib/core/stores/remote";

jest.setTimeout(10000);

describe("Store: Schedules", () => {
  const stores: IStore[] = [new LocalStore()];

  if (process.env.RESONATE_STORE_URL) {
    stores.push(new RemoteStore(process.env.RESONATE_STORE_URL));
  }

  for (const store of stores.map((s) => s.schedules)) {
    describe(store.constructor.name, () => {
      test("Schedule Store: Create schedule", async () => {
        const scheduleId = "new-schedule";
        const cronExpression = "* * * * *"; // Every minute

        const createdSchedule = await store.create(
          scheduleId,
          scheduleId,
          undefined,
          cronExpression,
          undefined,
          "promise-1",
          1,
          undefined,
          undefined,
          undefined,
        );

        expect(createdSchedule.id).toBe(scheduleId);
        expect(createdSchedule.cron).toBe(cronExpression);

        // Clean up
        await store.delete(scheduleId);
      });

      // this test needs to be discussed
      test("Schedule Store: Create schedule that exists with same idempotency key", async () => {
        const scheduleId = "existing-schedule";
        const cronExpression = "* * * * *"; // Every minute

        // Create the initial schedule
        await store.create(
          scheduleId,
          scheduleId,
          undefined,
          cronExpression,
          undefined,
          "promise-1",
          1,
          undefined,
          undefined,
          undefined,
        );

        const schedule = await store.create(
          scheduleId,
          scheduleId,
          undefined,
          cronExpression,
          undefined,
          "promise-1",
          1,
          undefined,
          undefined,
          undefined,
        );

        expect(schedule.id).toBe(scheduleId);
        expect(schedule.cron).toBe(cronExpression);
        expect(schedule.idempotencyKey).toBe(scheduleId);

        // Clean up
        await store.delete(scheduleId);
      });

      test("Schedule Store: Create schedule that exists with different idempotency key", async () => {
        const scheduleId = "existing-schedule";
        const cronExpression = "* * * * *"; // Every minute

        // Create the initial schedule
        await store.create(
          scheduleId,
          scheduleId,
          undefined,
          cronExpression,
          undefined,
          "promise-1",
          1,
          undefined,
          undefined,
          undefined,
        );

        // Attempt to create a schedule with a different idempotency key, should throw error
        await expect(
          store.create(
            scheduleId,
            "new-idempotency-key",
            undefined,
            cronExpression,
            undefined,
            "promise-1",
            1,
            undefined,
            undefined,
            undefined,
          ),
        ).rejects.toThrowError("Already exists");

        // Clean up
        await store.delete(scheduleId);
      });

      test("Schedule Store: Get schedule that exists", async () => {
        const scheduleId = "existing-schedule";
        const cronExpression = "* * * * *"; // Every minute

        // Create the schedule
        await store.create(
          scheduleId,
          scheduleId,
          undefined,
          cronExpression,
          undefined,
          "promise-1",
          1,
          undefined,
          undefined,
          undefined,
        );

        // Get the existing schedule
        const existingSchedule = await store.get(scheduleId);
        expect(existingSchedule.id).toBe(scheduleId);

        // Clean up
        await store.delete(scheduleId);
      });

      test("Schedule Store: Get schedule that does not exist", async () => {
        const nonExistingScheduleId = "non-existing-schedule-id";

        // Attempt to get a schedule that does not exist, should throw NOT_FOUND error
        await expect(store.get(nonExistingScheduleId)).rejects.toThrowError(
          "Not found",
        );
      });

      test("Schedule Store: Delete schedule that exists", async () => {
        const scheduleId = "schedule-to-delete";

        // Create the schedule first
        await store.create(
          scheduleId,
          scheduleId,
          undefined,
          "* * * * *",
          undefined,
          "promise-1",
          1,
          undefined,
          undefined,
          undefined,
        );

        // Attempt to delete the schedule
        const isDeleted = await store.delete(scheduleId);
        expect(isDeleted).toBeUndefined();

        // Attempt to get the deleted schedule, should throw NOT_FOUND error
        await expect(store.get(scheduleId)).rejects.toThrowError("Not found");
      });

      test("Schedule Store: Delete schedule that does not exist", async () => {
        const nonExistingScheduleId = "non-existing-schedule-id";

        // Attempt to delete a schedule that does not exist, should throw NOT_FOUND error
        await expect(store.delete(nonExistingScheduleId)).rejects.toThrowError(
          "Not found",
        );
      });
    });
  }
});
