import { KafkaJS } from "@confluentinc/kafka-javascript";
import { type Context, KafkaMessageSource, KafkaNetwork, Resonate } from "./src/index";

function foo(ctx: Context): string {
  console.log("foo run");
  return "foo";
}

async function main() {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      clientId: "my-app",
      brokers: ["localhost:9092"], // adjust broker list
    },
  });

  const network = new KafkaNetwork({ kafka });
  await network.start();
  const msgSource = new KafkaMessageSource({ kafka });

  const resonate = new Resonate({ network, messageSource: msgSource });

  resonate.register(foo);

  const v = resonate.run("foo.102", foo);
  console.log(v);
}

main();
