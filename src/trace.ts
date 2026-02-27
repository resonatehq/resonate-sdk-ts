export type TraceEvent = {
  event: "async" | "spawn" | "await" | "block" | "resume" | "return" | "dedup";
  func: string;
  id: string;
};

export const trace: TraceEvent[][] = [];
export let traceEnabled = false;

export function enableTrace() {
  traceEnabled = true;
}

export function clearTrace() {
  trace.splice(0, trace.length);
}

export function newExecution() {
  if (traceEnabled) {
    trace.push([]);
  }
}

export function traceEvent(event: TraceEvent["event"], func: string, id: string) {
  if (traceEnabled && trace.length > 0) {
    trace[trace.length - 1].push({ event, func, id });
  }
}

export function logTrace() {
  console.log(`\n--- Trace (${trace.length} executions) ---`);
  for (let i = 0; i < trace.length; i++) {
    const execution = trace[i];
    console.log(`\nexecution ${i + 1} (${execution.length} events):`);
    const eventW = Math.max(5, ...execution.map((e) => e.event.length));
    const funcW = Math.max(4, ...execution.map((e) => e.func.length));
    console.log(`  ${"#".padStart(3)}  ${"event".padEnd(eventW)}  ${"func".padEnd(funcW)}  id`);
    console.log(`  ${"".padStart(3)}  ${"".padEnd(eventW, "-")}  ${"".padEnd(funcW, "-")}  ----`);
    for (let j = 0; j < execution.length; j++) {
      const e = execution[j];
      console.log(`  ${String(j + 1).padStart(3)}  ${e.event.padEnd(eventW)}  ${e.func.padEnd(funcW)}  ${e.id}`);
    }
  }
}
