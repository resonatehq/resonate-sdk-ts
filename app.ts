import type { Context } from "./src/context";
import { Resonate } from "./src/resonate";

export function* countdown(ctx: Context, count: number, delay: number, url: string) {
  for (let i = count; i > 0; i--) {
    // send notification to ntfy.sh
    yield* ctx.run(notify, url, `Countdown: ${i}`);
    // sleep
    yield* ctx.sleep(delay * 60 * 1000);
  }
  // send the last notification to ntfy.sh
  yield* ctx.run(notify, url, `Done`);
}

async function notify(_ctx: Context, url: string, msg: string) {
  await fetch(url, {
    method: "POST",
    body: msg,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}

const resonate = Resonate.remote();

async function main() {
  resonate.register(countdown);
}

main();
