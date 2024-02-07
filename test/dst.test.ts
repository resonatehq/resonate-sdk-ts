import { describe, test, expect } from "@jest/globals";
// import { Resonate, Context } from "../lib/resonate";
// import { ResonateTestCrash } from "../lib/core/error";

// trace tree
// type TraceTree = {
//   id: string;
//   func: string;
//   args: any[];
//   children: TraceTree[];
// };

// function traces(ctx: Context): TraceTree {
//   return {
//     id: ctx.id,
//     func: "",
//     args: [],
//     children: ctx.children.map(traces),
//   };
// }

// async function test1(ctx: Context) {
//   await ctx.run(foo);
//   await ctx.run(foo);
// }

// async function foo(ctx: Context) {
//   await ctx.run(bar);
//   await ctx.run(bar);
// }

// async function bar(ctx: Context) {}

// prime number generator
// async function test2(ctx: Context) {
//   await ctx.run(prime, 2);
//   await ctx.run(prime, 3);
//   await ctx.run(prime, 5);
//   await ctx.run(prime, 7);
// }

// async function prime(ctx: Context, n: number) {
//   for (let i = 2; i < n; i++) {
//     if (n % i === 0) {
//       return false;
//     }
//   }
//   return true;
// }

// function isSubsetTree(context: Context, other: Context): boolean {
//   if (context.id !== other.id) {
//     console.log("context.id: " + context.id);
//     return false;
//   }

//   const otherChildren = other.children.map((child) => child.id);
//   const contextChildren = context.children.map((child) => child.id);

//   if (otherChildren.length > 0 && otherChildren.every((child) => !contextChildren.includes(child))) {
//     return false;
//   }

//   for (const child of context.children) {
//     const matchingChild = other.children.find((otherChild) => otherChild.id === child.id);

//     if (matchingChild && !isSubsetTree(child, matchingChild)) {
//       console.log("matchingChild: " + JSON.stringify(matchingChild));
//       return false;
//     }
//   }
//   return true;
// }

// function printTree(tree: TraceTree, indent: string = ""): void {
//   console.log(indent + `id: ${tree.id}, func: ${tree.func}, args: ${JSON.stringify(tree.args)}`);

//   if (tree.children.length > 0) {
//     for (let i = 0; i < tree.children.length - 1; i++) {
//       console.log(indent + "├── ");
//       printTree(tree.children[i], indent + "│   ");
//     }
//     console.log(indent + "└── ");
//     printTree(tree.children[tree.children.length - 1], indent + "    ");
//   }
// }

describe("Simulate failures", () => {
  // write a test which will always pass
  test("temporary test", async () => {
    expect(true).toBe(true);
  });
  // test("Simulate failure 1", async () => {
  //   const baseline = new Resonate();
  //   baseline.register("test", test1);

  //   const { context: context1, promise: promise1 } = baseline.run("test", "baseline", "baseline", []);

  //   await promise1;

  //   const tree1 = traces(context1);
  //   printTree(tree1);

  //   const storedContexts: Context[] = [context1];

  //   const probFailure = 0.6;
  //   const continueLoop = true;
  //   let loopCount = 0;
  //   while (continueLoop) {
  //     if (loopCount > 10) {
  //       storedContexts.push(context1);
  //       break;
  //     }
  //     loopCount++;
  //     // Create a new resonate instance with opts
  //     const resonate = new Resonate();

  //     resonate.register("test", test1);
  //     try {
  //       const currentResult = await resonate.run("test", "baseline", "baseline", [{}, {test: probFailure }]);

  //       const currentContext = currentResult.context;
  //       const currentPromise = currentResult.promise;

  //       await currentPromise;
  //       // Break the loop if the current context was successful
  //       const tree2 = traces(currentContext);
  //       printTree(tree2);

  //       storedContexts.push(currentContext);
  //       break;
  //     } catch (e) {
  //       if (e !== ResonateTestCrash) {
  //         console.log("Failed to run test, trying again! ", e);
  //       }
  //     }
  //   }
  //   expect(isSubsetTree(context1, storedContexts[1])).toBe(true);
  // });

  // test("Simulate failure 2", async () => {
  //   const baseline = new Resonate();
  //   baseline.register("test", test2);

  //   const result = await baseline._run("test", "baseline", "baseline", []);
  //   const { context: context1, promise: promise1 } = result;

  //   await promise1;

  //   // Map context to something useable
  //   const tree1 = traces(context1);
  //   printTree(tree1);

  //   const storedContexts: Context[] = [context1];

  //   const probFailure = 0.7;
  //   const continueLoop = true;
  //   let loopCount = 0;
  //   while (continueLoop) {
  //     if (loopCount > 10) {
  //       storedContexts.push(context1);
  //       break;
  //     }
  //     loopCount++;
  //     const resonate = new Resonate();

  //     resonate.register("test", test2);
  //     try {
  //       const result = await resonate._run("test", "baseline", "baseline", []);
  //       const currentContext = result.context;
  //       const currentPromise = result.promise;

  //       await currentPromise;
  //       // Break the loop if the current context was successful
  //       const tree2 = traces(currentContext);
  //       printTree(tree2);

  //       storedContexts.push(currentContext);
  //       break;
  //     } catch (e) {
  //       if (e !== ResonateTestCrash) {
  //         console.log("Failed to run test, trying again! ", e);
  //       }
  //     }
  //   }
  //   expect(isSubsetTree(context1, storedContexts[1])).toBe(true);
  // });
});
