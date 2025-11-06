import { type Context, context, propagation, type Span, type Tracer, trace } from "@opentelemetry/api";
export interface ITracer {
  startSpan(id: string, startTime?: number): ISpan;
  decode(headers: Record<string, string>): ISpanContext;
}

export interface ISpanContext {
  startSpan(id: string, startTime?: number): ISpan;
  encode(): Record<string, string>;
}

export interface ISpan {
  setAttribute(key: string, value: any): void;
  context(): ISpanContext;
  end(): void;
}

export class NoopTracer {
  startSpan(id: string, startTime?: number): ISpan {
    return new NoopSpan();
  }
  decode(headers: Record<string, string>): ISpanContext {
    return new NoopSpanContext();
  }
}

export class NoopSpanContext {
  startSpan(id: string, startTime?: number): ISpan {
    return new NoopSpan();
  }
  encode(): Record<string, string> {
    return {};
  }
}

export class NoopSpan {
  setAttribute(key: string, value: any): void {}
  context(): ISpanContext {
    return new NoopSpanContext();
  }
  end(): void {}
}

export class OtelTracer {
  private t: Tracer;
  constructor(name: string, version?: string) {
    this.t = trace.getTracer(name, version);
  }
  startSpan(id: string, startTime?: number): ISpan {
    const span = this.t.startSpan(id, { startTime: startTime });
    return new OtelSpan(this.t, span);
  }
  decode(headers: Record<string, string>): ISpanContext {
    const ctx = propagation.extract(context.active(), headers);
    return new OtelSpanContext(this.t, ctx);
  }
}

export class OtelSpanContext {
  private t: Tracer;
  private c: Context;
  constructor(t: Tracer, c: Context) {
    this.t = t;
    this.c = c;
  }
  startSpan(id: string, startTime?: number): ISpan {
    const span = this.t.startSpan(id, { startTime: startTime }, this.c);
    return new OtelSpan(this.t, span);
  }

  encode(): Record<string, string> {
    const headers: Record<string, string> = {};
    propagation.inject(this.c, headers);
    return headers;
  }
}

export class OtelSpan {
  private t: Tracer;
  private s: Span;
  constructor(t: Tracer, s: Span) {
    this.t = t;
    this.s = s;
  }
  setAttribute(key: string, value: any): void {
    this.s.setAttribute(key, value);
  }

  context(): ISpanContext {
    const ctx = trace.setSpan(context.active(), this.s);
    return new OtelSpanContext(this.t, ctx);
  }
  end(): void {
    this.s.end();
  }
}
