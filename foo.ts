import { Resonate } from "./lib";

// instantiate resonate
const resonate = new Resonate({
    url: "http://localhost:8001",
});

async function main() {
    // create a durable promise
    const durablePromise = await resonate.promises.create("myPromise", Date.now() + 60000, {
        idempotencyKey: "myIdempotencyKey",
    });

    // wait for the durable promise to be resolved
    const v = await durablePromise.wait(30000);
    console.log(v);
}

main();
