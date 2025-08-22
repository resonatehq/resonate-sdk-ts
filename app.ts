import { console } from "node:inspector/promises"
import {Context} from "./src/context"
import {Resonate} from "./src/resonate"
function* foo(ctx: Context): Generator<any, string, any>{
  const v = yield* ctx.run(bar)
  return v
}

function bar(ctx: Context): string {
  return "hi"
}


const resonate = Resonate.local()
resonate.register("foo", foo)

async function main() {
  const p1 = await resonate.beginRun("foo.1", foo)
  const p2 = await resonate.beginRun("foo.2", foo)
  const v1 = await p1.result
  const v2 = await p2.result
  console.log(v1 == v2)

}

main()
