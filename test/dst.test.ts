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

const resonate = new Resonate();

resonate.register("test", test);
resonate.register("test2", test2);

async function test(ctx: Context) {
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
    await ctx.run(bar);
  }

async function bar(ctx: Context) {}

function isSubsetTree(context: Context, other: Context): boolean {

    if (context.id !== other.id) {
        return false;
    }

    for (const child of context.children) {
        if (isCompletedPromise(child)) {
            continue;
        }
        
        const matchingChild = other.children.find((otherchild) => otherchild.id === child.id && otherchild.parent?.id === child.parent?.id);

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
  const { context, promise } = resonate._run("test", "baseline");
  await promise;

  // map context to something useable
  const traceTree = traces(context);

  printTree(traceTree);
  
  const { context: context2, promise: promise2 } = resonate._run("test2", "baseline");
  await promise2;

  const traceTree2 = traces(context2);
  printTree(traceTree2);

  console.log(isSubsetTree(context, context2));

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