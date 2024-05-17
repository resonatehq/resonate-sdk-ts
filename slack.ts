import { Resonate, Context } from "./lib";

const resonate = new Resonate({
  url: "http://localhost:8001",
});

resonate.register("myFunction", async (c : Context) => {
  let v = await c.run("my/unique/id");
  console.log(v);
});

resonate.run("myFunction", "myFunction.1");

// From somewhere else in your process or an entirely different process
setTimeout(() => {
  resonate.promises.resolve("my/unique/id", 42);
}, 1000);