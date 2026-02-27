export type TraceEvent = {
  event: "async" | "spawn" | "await" | "block" | "resume" | "return" | "dedup";
  func: string;
  id: string;
};

export class ExecutionTrace {
  constructor(private readonly events: TraceEvent[] | null) {}

  event(type: TraceEvent["event"], func: string, id: string): void {
    this.events?.push({ event: type, func, id });
  }
}

export class Tracer {
  public readonly executions: TraceEvent[][] = [];
  private enabled = false;

  enable(): void {
    this.enabled = true;
  }

  clear(): void {
    this.executions.length = 0;
  }

  newExecution(): ExecutionTrace {
    if (!this.enabled) return new ExecutionTrace(null);
    const events: TraceEvent[] = [];
    this.executions.push(events);
    return new ExecutionTrace(events);
  }

  log(): void {
    console.log(`\n--- Trace (${this.executions.length} executions) ---`);
    for (let i = 0; i < this.executions.length; i++) {
      const execution = this.executions[i];
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
}
