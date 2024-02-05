import { describe, test, expect } from "@jest/globals";
import { Resonate, Context } from "../lib/resonate";

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

async function test1(ctx: Context) {
  await ctx.run(foo);
  await ctx.run(foo);
}

async function foo(ctx: Context) {
  await ctx.run(bar);
  await ctx.run(bar);
}

async function bar(ctx: Context) {}

function isSubsetTree(context: Context, other: Context): boolean {
  if (context.id !== other.id) {
    console.log("context.id: " + context.id);
    return false;
  }

  const otherChildren = other.children.map((child) => child.id);
  const contextChildren = context.children.map((child) => child.id);

  if (otherChildren.length > 0 && otherChildren.every((child) => !contextChildren.includes(child))) {
    return false;
  }

  for (const child of context.children) {
    const matchingChild = other.children.find((otherChild) => otherChild.id === child.id);

    if (matchingChild && !isSubsetTree(child, matchingChild)) {
      console.log("matchingChild: " + JSON.stringify(matchingChild));
      return false;
    }
  }
  return true;
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

describe("Simulate failures", () => {
  test("Simulate failure 1", async () => {
    const baseline = new Resonate();
    baseline.register("test", test1);

    const { context: context1, promise: promise1 } = baseline._run("test", "baseline");
    await promise1;

    // Map context to something useable
    const tree1 = traces(context1);
    printTree(tree1);

    const storedContexts: Context[] = [context1];

    const probFailure = 0.8;
    console.log("simulated probability of failure: " + probFailure);
    while (true) {
      const resonate = new Resonate();

      resonate.register("test", test1);
      try {
        const testRandomSeed = Math.random();
        console.log("testRandomSeed: " + testRandomSeed);
        const { context: currentContext, promise: currentPromise } = resonate._run("test", "baseline", {
          test: probFailure,
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
    expect(isSubsetTree(context1, storedContexts[1])).toBe(true);
  });
});
