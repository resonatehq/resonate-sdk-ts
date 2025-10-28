import { type Tracer as OtelTracer, type Span, SpanStatusCode } from "@opentelemetry/api";

import * as util from "./util";
export interface Tracer {
  startSpan(id: string, at: number): void;
  endSpan(id: string, at: number): void;
}

export class ResonateTracer implements Tracer {
  private tracer: OtelTracer;
  private spans: Map<string, Span>;

  constructor({ tracer }: { tracer: OtelTracer }) {
    this.tracer = tracer;
    this.spans = new Map();
  }

  startSpan(id: string, at: number): void {
    const existing = this.spans.get(id);
    if (existing) {
      existing.addEvent("resumed", at);
      return;
    }
    const rootSpan = this.tracer.startSpan(id, {
      startTime: at,
    });
    this.spans.set(id, rootSpan);
    return;
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
  startSpan(id: string, at: number): void {}
  endSpan(id: string, at: number): void {}
}
