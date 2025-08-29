import {Resonate} from "./src/resonate"
import { Context } from "./src/context"

const resonate = Resonate.remote()

function* foo(ctx: Context){
  const v = yield* ctx.rfc("bar")
  // console.log("going to sleep")
  // yield* ctx.sleep(3600000)
  // console.log("woke up")
  return v

}

function bar(ctx: Context): string{
  return "hello world"
}


resonate.register("foo", foo)
resonate.register("bar", bar)

const h = await resonate.beginRun("foo", foo)
console.log("handle: ", h)
const v = await h.result()
console.log("result: ", v)
resonate.stop()
