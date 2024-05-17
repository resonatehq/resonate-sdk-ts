import { Resonate, Context } from "./lib";

const resonate = new Resonate();

resonate.schedule("everyMinute", "* * * * *", (ctx: Context) => {
  console.log("invoked!")
});

resonate.start();
