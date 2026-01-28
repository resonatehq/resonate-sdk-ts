export interface Tracer {
  startSpan(id: string, startTime: number): Span;
  decode(headers: { [key: string]: string }): Span;
}

export interface Span {
  startSpan(id: string, startTime: number): Span;
  encode(): { [key: string]: string };
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(success: boolean, message?: string): void;
  end(endTime: number): void;
}

export class NoopTracer {
  startSpan(id: string, startTime: number): NoopSpan {
    return new NoopSpan();
  }
  decode(headers: { [key: string]: string }): Span {
    return new NoopSpan();
  }
}

export class NoopSpan {
  startSpan(id: string, startTime: number): Span {
    return new NoopSpan();
  }
  setAttribute(key: string, value: string | number | boolean): void {}
  setStatus(success: boolean, message?: string): void {}
  encode(): { [key: string]: string } {
    return {};
  }
  end(endTime: number): void {}
}
