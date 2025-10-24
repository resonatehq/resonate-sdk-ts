import type { Tracer as otelTracer, Span } from "@opentelemetry/api";
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";

export interface Tracer {
  startSpan(id: string, rId: string, at: number): void;
  addEvent(id: string, event: string, at: number): void;
  endSpan(id: string, at: number): void;
}
export class ResonateTracer implements Tracer {
  private tracer: otelTracer;
  private spans: Map<string, Span>;

  constructor({ tracer }: { tracer: otelTracer }) {
    this.tracer = tracer;
    this.spans = new Map();
  }

  startSpan(id: string, rId: string, at: number): void {
    const existingSpan = this.spans.get(id);
    if (existingSpan) {
      this.addEvent(id, "resumed", at);
      return;
    }

    if (id === rId) {
      // Root span
      const rootSpan = this.tracer.startSpan(id, { startTime: at });
      this.spans.set(id, rootSpan);
      return;
    }

    // Child span
    const parentSpan = this.spans.get(rId);
    if (!parentSpan) {
      throw new Error(`Parent span with id "${rId}" not found.`);
    }

    const ctx = otelTrace.setSpan(otelContext.active(), parentSpan);
    const childSpan = this.tracer.startSpan(id, { startTime: at }, ctx);
    this.spans.set(id, childSpan);
  }

  addEvent(id: string, event: string, at: number) {
    const span = this.spans.get(id);
    if (!span) {
      throw new Error(`Span with id "${id}" not found.`);
    }
    span.addEvent(event, at);
  }

  endSpan(id: string, at: number) {
    const span = this.spans.get(id);
    if (!span) {
      throw new Error(`Span with id "${id}" not found.`);
    }
    span.end(at);
    this.spans.delete(id);
  }
}

export class NoopTracer implements Tracer {
  startSpan(id: string, rId: string, at: number): void {}

  addEvent(id: string, event: string, at: number) {}

  endSpan(id: string, at: number) {}
}
