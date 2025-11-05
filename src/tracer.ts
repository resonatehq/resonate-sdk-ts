import { context, propagation, type Span, type Tracer, trace } from "@opentelemetry/api";

export interface ISpan {
  setAttribute(key: string, value: any): void;
  end(): void;
}
export interface ITracer {
  startSpan(id: string, startTime?: number, headers?: Record<string, string>): ISpan;
  propagationHeaders(span: ISpan): Record<string, string>;
}

class NoopSpan {
  setAttribute(key: string, value: any): void {}
  end(): void {}
}
export class NoopTracer implements ITracer {
  startSpan(id: string, startTime?: number, headers?: Record<string, string>): ISpan {
    return new NoopSpan();
  }
  propagationHeaders(span: ISpan): Record<string, string> {
    return {};
  }
}

export class OtelTracer {
  private tracer: Tracer;
  constructor(name: string, version?: string) {
    this.tracer = trace.getTracer(name, version);
  }
  startSpan(id: string, startTime?: number, headers?: Record<string, string>): ISpan {
    let span: Span;
    if (headers !== undefined) {
      span = this.tracer.startSpan(id, { startTime: startTime }, propagation.extract(context.active(), headers));
    } else {
      span = this.tracer.startSpan(id, { startTime: startTime });
    }

    return span;
  }

  propagationHeaders(span: Span): Record<string, string> {
    const ctx = trace.setSpan(context.active(), span);
    const headers: Record<string, string> = {};
    propagation.inject(ctx, headers);
    return headers;
  }
}
