/**
 * Example demonstrating the high-level schedule API.
 */

import { type Context, Resonate } from "./src/resonate";

// Create a local Resonate instance for testing
const resonate = Resonate.local();

// Example 1: Schedule using resonate.schedule()
console.log("Example 1: Schedule using resonate.schedule()");
const generateReport = resonate.register("generateReport", async (ctx: Context, userId: number, reportType: string) => {
  return `Generated ${reportType} report for user ${userId}`;
});

const schedule1 = await resonate.schedule(
  "daily_report_schedule",
  "0 9 * * *", // Every day at 9am
  generateReport,
  123,
  "daily",
);
console.log(`Created schedule: daily_report_schedule`);
console.log();

// Example 2: Schedule using function.schedule()
console.log("Example 2: Schedule using function.schedule()");
const schedule2 = await generateReport.schedule(
  "weekly_report_schedule",
  "0 9 * * 1", // Every Monday at 9am
  456,
  "weekly",
);
console.log(`Created schedule: weekly_report_schedule`);
console.log();

// Example 3: Schedule with options (timeout and tags)
console.log("Example 3: Schedule with custom options");
const schedule3 = await resonate
  .options({
    timeout: 3600000,
    tags: { env: "production", priority: "high" },
  })
  .schedule(
    "priority_report_schedule",
    "*/30 * * * *", // Every 30 minutes
    generateReport,
    789,
    "realtime",
  );
console.log(`Created schedule: priority_report_schedule`);
console.log();

// Example 4: Schedule by name
console.log("Example 4: Schedule using function name");
const schedule4 = await resonate.schedule(
  "analytics_report_schedule",
  "0 0 * * *", // Every day at midnight
  "generateReport",
  999,
  "analytics",
);
console.log(`Created schedule: analytics_report_schedule`);
console.log();

// Cleanup
console.log("Cleaning up schedules...");
await schedule1.delete();
await schedule2.delete();
await schedule3.delete();
await schedule4.delete();
console.log("Done!");
