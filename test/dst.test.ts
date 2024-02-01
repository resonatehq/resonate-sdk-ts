import { Resonate, Context } from "../lib/resonate";
import { isCompletedPromise } from "../lib/core/promise";

// trace tree
type TraceTree = {
  id: string;
  func: string;
  args: any[];
  children: TraceTree[];
};

function traces(ctx: Context): TraceTree {
  return {
    id: ctx.id,
    func: "",
    args: [],
    children: ctx.children.map(traces),
  };
}

function simulatedFailure(prob: number): void {
  if (Math.random() < prob) {
    throw new Error("Simulated failure with prob: " + prob);
  }
}

// ResonateTestError

const baseline = new Resonate();

baseline.register("test", test1);

async function test1(ctx: Context) {
  //   if (Math.random() < 0.1) {
  //     throw new Error("Simulated failure in foo");
  //   }

  await ctx.run(foo);
  await ctx.run(foo);
}

async function test2(ctx: Context) {
  await ctx.run(foo2);
  await ctx.run(foo2);
}

async function foo(ctx: Context) {
  await ctx.run(bar);
  await ctx.run(bar);
}

async function foo2(ctx: Context) {
  await ctx.run(bar2);
  await ctx.run(bar2);
}

async function bar(ctx: Context) {}

async function bar2(ctx: Context) {
  simulatedFailure(0.2);
}

function isSubsetTree(context: Context, other: Context): boolean {
  if (context.id !== other.id) {
    return false;
  }

  for (const child of context.children) {
    if (isCompletedPromise(child)) {
      continue;
    }

    const matchingChild = other.children.find(
      (otherchild) => otherchild.id === child.id && otherchild.parent?.id === child.parent?.id,
    );

    if (!matchingChild) {
      return false;
    }

    if (!isSubsetTree(child, matchingChild)) {
      return false;
    }
  }
  return true;
}

async function main() {
  const { context: context1, promise: promise1 } = baseline._run("test", "baseline");
  await promise1;

  // Map context to something useable
  const tree1 = traces(context1);
  printTree(tree1);

  const storedContexts: Context[] = [context1];

  let currentContext: Context;
  const probFailure = 0.6;
  console.log("simulated probability of failure: " + probFailure);
  while (true) {
    const resonate = new Resonate();

    resonate.register("test", test2);
    try {
      const testRandomSeed = Math.random();
      console.log("testRandomSeed: " + testRandomSeed);
      const { context: currentContext, promise: currentPromise } = resonate._run("test", "baseline", {
        testFailureProb: probFailure,
        testRandomSeed: testRandomSeed,
      });

      await currentPromise;
      // Break the loop if the current context was successful
      const tree2 = traces(currentContext);
      printTree(tree2);

      storedContexts.push(currentContext);
      break;
    } catch (e) {
      console.log("Failed to run test, trying again!");
    }
  }

  // Compare every stored context to assert that each is a subset
  for (const storedContext of storedContexts) {
    console.log(isSubsetTree(context1, storedContext));
  }
}

function printTree(tree: TraceTree, indent: string = ""): void {
  console.log(indent + `id: ${tree.id}, func: ${tree.func}, args: ${JSON.stringify(tree.args)}`);

  if (tree.children.length > 0) {
    for (let i = 0; i < tree.children.length - 1; i++) {
      console.log(indent + "├── ");
      printTree(tree.children[i], indent + "│   ");
    }
    console.log(indent + "└── ");
    printTree(tree.children[tree.children.length - 1], indent + "    ");
  }
}

main();
