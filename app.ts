import { Context } from "./src/context";
import { Resonate } from "./src/resonate";


const resonate = Resonate.remote({group: "group-b"})


function* foo(ctx: Context, args: any): any{
  const promise = yield ctx.beginRpc(bar, args, ctx.options({target:"poll://any@group-b"}))
  const value = promise
  return value
}


function bar(ctx: Context, args: any): any{
  return
}
