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
