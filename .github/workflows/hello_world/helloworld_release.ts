import { Context, Resonate } from "@resonatehq/sdk";

const resonate = new Resonate();
console.log("Hello World!", resonate);

resonate.schedule("everyMinute", "* * * * *", (ctx: Context) => {
  console.log("every minute", Date.now());
});
