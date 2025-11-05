export interface Span {
  setAttribute(key: string, value: any): void;
  end(): void;
}
export interface Tracer {
  startSpan(id: string, startTime?: number, headers?: Record<string, string>): Span;
  propagationHeaders(span: Span): Record<string, string>;
}

class NoopSpan {
  setAttribute(key: string, value: any): void {}
  end(): void {}
}
export class NoopTracer {
  startSpan(id: string, startTime?: number, headers?: Record<string, string>): Span {
    return new NoopSpan();
  }
  propagationHeaders(span: Span): Record<string, string> {
    return {};
  }
}
