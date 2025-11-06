export interface Tracer {
  startSpan(id: string, startTime: number): Span;
  decode(headers: Record<string, string>): SpanContext;
}

export interface SpanContext {
  startSpan(id: string, startTime: number): Span;
  encode(): Record<string, string>;
}

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  context(): SpanContext;
  end(endTime: number): void;
}

export class NoopTracer {
  startSpan(id: string, startTime: number): Span {
    return new NoopSpan();
  }
  decode(headers: Record<string, string>): SpanContext {
    return new NoopSpanContext();
  }
}

export class NoopSpanContext {
  startSpan(id: string, startTime: number): Span {
    return new NoopSpan();
  }
  encode(): Record<string, string> {
    return {};
  }
}

export class NoopSpan {
  setAttribute(key: string, value: string | number | boolean): void {}
  context(): SpanContext {
    return new NoopSpanContext();
  }
  end(endTime: number): void {}
}

import {
  type Context,
  context,
  type Span as OSpan,
  type Tracer as OTracer,
  propagation,
  trace,
} from "@opentelemetry/api";

export class OpenTelemetryTracer {
  private t: OTracer;
  constructor(name: string, version?: string) {
    this.t = trace.getTracer(name, version);
  }
  startSpan(id: string, startTime: number): Span {
    return new OpenTelemetrySpan(this.t, this.t.startSpan(id, { startTime: startTime }));
  }
  decode(headers: Record<string, string>): SpanContext {
    return new OpenTelemetrySpanContext(this.t, propagation.extract(context.active(), headers));
  }
}

export class OpenTelemetrySpanContext {
  private t: OTracer;
  private c: Context;

  constructor(t: OTracer, c: Context) {
    this.t = t;
    this.c = c;
  }
  startSpan(id: string, startTime: number): Span {
    return new OpenTelemetrySpan(this.t, this.t.startSpan(id, { startTime: startTime }, this.c));
  }

  encode(): Record<string, string> {
    const headers: Record<string, string> = {};
    propagation.inject(this.c, headers);
    return headers;
  }
}

export class OpenTelemetrySpan {
  private t: OTracer;
  private s: OSpan;

  constructor(t: OTracer, s: OSpan) {
    this.t = t;
    this.s = s;
  }
  setAttribute(key: string, value: string | number | boolean): void {
    this.s.setAttribute(key, value);
  }

  context(): SpanContext {
    return new OpenTelemetrySpanContext(this.t, trace.setSpan(context.active(), this.s));
  }
  end(endTime: number): void {
    this.s.end(endTime);
  }
}
