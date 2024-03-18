import { ILogger } from "../logger";

type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger implements ILogger {
  private _level: number;

  constructor(public level: LogLevel = "info") {
    switch (level) {
      case "debug":
        this._level = 0;
        break;
      case "info":
        this._level = 1;
        break;
      case "warn":
        this._level = 2;
        break;
      case "error":
        this._level = 3;
        break;
    }
  }

  debug(...args: any[]): void {
    this.log(0, args);
  }

  info(...args: any[]): void {
    this.log(1, args);
  }

  warn(...args: any[]): void {
    this.log(2, args);
  }

  error(...args: any[]): void {
    this.log(3, args);
  }

  private log(level: number, args: any[]): void {
    if (this._level <= level) {
      console.log(...args);
    }
  }
}
