import { Resonate, Context } from "./lib";

const resonate = new Resonate({
  timeout: 60000,
  url: "http://localhost:8001"
});

resonate.register("sleep", async (ctx: Context) => {
  console.log("time to sleep");
  await ctx.sleep(30000);
  console.log("aaand we done!")
});

resonate.run("sleep", "sleep.1");