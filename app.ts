import { Resonate} from "./src/resonate";
import {Context} from "./src/context"

async function notify(ctx: Context, url: string, msg: string) {
  await fetch(url, {
    method: "POST",
    body: msg,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}

export function* countdown(
  ctx: Context,
  count: number,
  delay: number, // in minutes
  url: string,
) {
  // Capture the start time once, durably
  const start = yield* ctx.date.now();
  const interval = delay * 60 * 1000;

  for (let i = count; i > 0; i--) {
    // Precompute when this tick should happen
    const scheduledAt = new Date(start + (count - i) * interval);

    // Sleep until that time (or continue immediately if already past)
    yield* ctx.sleep({until: scheduledAt});

    // Send the countdown message
    yield* ctx.run(notify, url, `Countdown: ${i}`);
  }

  // Final "done" message
  yield* ctx.run(notify, url, `Done`);
}



const resonate = Resonate.remote({
  url: "http://localhost:8001",
});

resonate.register("countdown", countdown);
