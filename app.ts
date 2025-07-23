import {Promises} from "./src/promises"
import * as util from "./src/util";

const promises = new Promises()
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function main(){
  await promises.create("foo", Date.now() + 10_000)
  await sleep(10_000 + 1_000)
  const created = await promises.get("foo")
  util.assert(created.state === "rejected_timedout")
}

main()
