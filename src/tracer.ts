export interface Span {
  greet(): void;
}
export interface Tracer {
  startSpan(id: string, startTime: number): Span;
  propagationHeaders(span: Span): Record<string, string>;
}
