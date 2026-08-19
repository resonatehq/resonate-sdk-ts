/**
 * Structured logging interface for the Resonate SDK and its connectors.
 *
 * Users can inject any logger that satisfies this interface (e.g., pino,
 * winston). The core SDK ships a default `ConsoleLogger` implementation.
 */
export interface Logger {
  debug(fields: Record<string, any>, msg: string): void;
  info(fields: Record<string, any>, msg: string): void;
  warn(fields: Record<string, any>, msg: string): void;
  error(fields: Record<string, any>, msg: string): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
