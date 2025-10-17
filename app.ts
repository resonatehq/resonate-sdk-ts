import {Resonate} from "./src/resonate"
import {Context} from "./src/context"
const resonate = Resonate.remote();

resonate.register("foo", () => "foo");

const v = await resonate.run("f1", "foo");
console.log(v);
resonate.stop()
