import { Resonate } from "../../dist/resonate";

const helloWorld = () => {
  console.log('Hello, Resonate World!');
};

const resonate = new Resonate();
resonate.register("helloWorld", helloWorld);

const runExample = async () => {
  const { context, promise } = resonate.runWithContext("helloWorld", "id");

  console.log('Running...');
  await promise;
  console.log(context.children);

  console.log('Done');
};

runExample();
