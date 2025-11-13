// app.ts
import { KafkaJS } from "@confluentinc/kafka-javascript";

async function run() {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      clientId: "my-app",
      brokers: ["localhost:9092"], // adjust broker list
      // ssl: true,
      // sasl: { mechanism: "plain", username: "...", password: "..." }
    },
  });

  const topic = "example-topic";

  // Producer
  const producer = kafka.producer();
  await producer.connect();
  console.log("Producer connected");

  const sendResult = await producer.send({
    topic,
    messages: [
      { key: "key1", value: "Hello Kafka" },
      { key: "key2", value: "Another message" },
    ],
  });
  console.log("Produced messages:", sendResult);

  // Consumer
  const consumer = kafka.consumer({ kafkaJS: { groupId: "example-group" } });
  await consumer.connect();
  console.log("Consumer connected");

  await consumer.subscribe({ topic });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      console.log({
        topic,
        partition,
        offset: message.offset,
        key: message.key?.toString(),
        value: message.value?.toString(),
      });
    },
  });

  // For demo: let it run for e.g. 5 seconds then disconnect
  setTimeout(async () => {
    await consumer.disconnect();
    console.log("Consumer disconnected");
    await producer.disconnect();
    console.log("Producer disconnected");
    process.exit(0);
  }, 50000);
}

run().catch((err) => {
  console.error("Error in Kafka app:", err);
  process.exit(1);
});
