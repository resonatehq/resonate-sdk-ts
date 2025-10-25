import type { Tracer as OtelTracer, Span } from "@opentelemetry/api";
import { context as otelContext, trace as otelTrace, SpanStatusCode } from "@opentelemetry/api";
import * as util from "./util";
export interface Tracer {
  startSpan(id: string, rId: string, at: number): void;
  suspendSpan(id: string, at: number): void;
  endSpan(id: string, at: number): void;
}

export class ResonateTracer implements Tracer {
  private tracer: OtelTracer;
  private spans: Map<string, Span>;

  constructor({ tracer }: { tracer: OtelTracer }) {
    this.tracer = tracer;
    this.spans = new Map();
  }

  startSpan(id: string, rId: string, at: number): void {
    const existing = this.spans.get(id);
    if (existing) {
      existing.addEvent("resumed", at);
      return;
    }

    let ctx = otelContext.active();

    // Root span
    if (id === rId) {
      const rootSpan = this.tracer.startSpan(id, {
        startTime: at,
      });
      this.spans.set(id, rootSpan);
      return;
    }

    // Child span
    const parentSpan = this.spans.get(rId);
    util.assertDefined(parentSpan);
    ctx = otelTrace.setSpan(ctx, parentSpan);
    const childSpan = this.tracer.startSpan(id, { startTime: at }, ctx);

    this.spans.set(id, childSpan);
  }

  suspendSpan(id: string, at: number): void {
    const span = this.spans.get(id);
    util.assertDefined(span);
    span.addEvent("suspend", at);
  }

  endSpan(id: string, at: number): void {
    const span = this.spans.get(id);
    util.assertDefined(span);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end(at);
    this.spans.delete(id);
  }
}

export class NoopTracer implements Tracer {
  startSpan(id: string, rId: string, at: number): void {}
  suspendSpan(id: string, at: number): void {}
  endSpan(id: string, at: number): void {}
}
