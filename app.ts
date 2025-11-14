import { KafkaJS } from "@confluentinc/kafka-javascript";

async function main(): Promise<void> {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      clientId: "my-app",
      brokers: ["localhost:9092"], // adjust broker list
    },
  });
  // Initialize consumer
  const consumer = kafka.consumer({
    "allow.auto.create.topics": true,
    "group.id": "groupId",
    "auto.offset.reset": "latest",
    "enable.auto.commit": false,
  });
  await consumer.connect();
  await consumer.subscribe({ topic: "resonate.messages" });
  await consumer.run({
    eachMessage: async ({ message }) => {
      console.log(message.value?.toString());
    },
  });
}

main();
