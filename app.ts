import { Resonate } from "./src/resonate";
import { Context } from "./src/context";

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
  url: string,
) {
  for (let i = count; i > 0; i--) {
    // send notification
    yield* ctx.run(notify, url, `Countdown: v2 ${i}`);
    // sleep
    yield* ctx.sleep(1 * 1000);
  }
  yield* ctx.run(notify, url, `Done`);
}


export function* countdownVa(
  ctx: Context,
  count: number,
  url: string,
) {
  for (let i = count; i > 0; i--) {
    // send notification
    yield* ctx.run(notify, url, `Countdown: v1 ${i}`);
    // sleep
    yield* ctx.sleep(1 * 1000);
  }
  yield* ctx.run(notify, url, `Done`);
}

const resonate = Resonate.remote({
  url: "http://localhost:8001",
});

resonate.register(countdown, {version: 2});
resonate.register("countdown", countdownVa, {version: 1});
