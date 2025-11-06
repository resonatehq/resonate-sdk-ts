export interface Tracer {
  startSpan(id: string, startTime?: number): SpanAdapter;
  decode(headers: Record<string, string>): SpanContext;
}

export interface SpanContext {
  startSpan(id: string, startTime?: number): SpanAdapter;
  encode(): Record<string, string>;
}

export interface SpanAdapter {
  setAttribute(key: string, value: any): void;
  context(): SpanContext;
  end(): void;
}

export class NoopTracer {
  startSpan(id: string, startTime?: number): SpanAdapter {
    return new NoopSpan();
  }
  decode(headers: Record<string, string>): SpanContext {
    return new NoopSpanContext();
  }
}

export class NoopSpanContext {
  startSpan(id: string, startTime?: number): SpanAdapter {
    return new NoopSpan();
  }
  encode(): Record<string, string> {
    return {};
  }
}

export class NoopSpan {
  setAttribute(key: string, value: any): void {}
  context(): SpanContext {
    return new NoopSpanContext();
  }
  end(): void {}
}

// import { type Context, context, propagation, type Span, type Tracer, trace } from "@opentelemetry/api";

// export class OpenTelemetryTracer {
//   private t: Tracer;
//   constructor(name: string, version?: string) {
//     this.t = trace.getTracer(name, version);
//   }
//   startSpan(id: string, startTime?: number): SpanAdapter {
//     const span = this.t.startSpan(id, { startTime: startTime });
//     return new OpenTelemetrySpan(this.t, span);
//   }
//   decode(headers: Record<string, string>): SpanContext {
//     const ctx = propagation.extract(context.active(), headers);
//     return new OpenTelemetrySpanContext(this.t, ctx);
//   }
// }

// export class OpenTelemetrySpanContext {
//   private t: Tracer;
//   private c: Context;
//   constructor(t: Tracer, c: Context) {
//     this.t = t;
//     this.c = c;
//   }
//   startSpan(id: string, startTime?: number): SpanAdapter {
//     const span = this.t.startSpan(id, { startTime: startTime }, this.c);
//     return new OpenTelemetrySpan(this.t, span);
//   }

//   encode(): Record<string, string> {
//     const headers: Record<string, string> = {};
//     propagation.inject(this.c, headers);
//     return headers;
//   }
// }

// export class OpenTelemetrySpan {
//   private t: Tracer;
//   private s: Span;
//   constructor(t: Tracer, s: Span) {
//     this.t = t;
//     this.s = s;
//   }
//   setAttribute(key: string, value: any): void {
//     this.s.setAttribute(key, value);
//   }

//   context(): SpanContext {
//     const ctx = trace.setSpan(context.active(), this.s);
//     return new OpenTelemetrySpanContext(this.t, ctx);
//   }
//   end(): void {
//     this.s.end();
//   }
// }
