// Core types and interfaces for Ruida Bridge

export interface Status {
  ok(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

export class ConsoleStatus implements Status {
  private logLevel: LogLevel;
  private startTime: number;

  constructor() {
    // Parse LOG_LEVEL from environment variable
    const envLevel = process.env.LOG_LEVEL?.toUpperCase();
    switch (envLevel) {
      case "ERROR":
        this.logLevel = LogLevel.ERROR;
        break;
      case "WARN":
        this.logLevel = LogLevel.WARN;
        break;
      case "INFO":
        this.logLevel = LogLevel.INFO;
        break;
      case "DEBUG":
        this.logLevel = LogLevel.DEBUG;
        break;
      default:
        // Default to INFO for production performance
        this.logLevel = LogLevel.INFO;
    }
    this.startTime = Date.now();
  }

  private getTimestamp(): string {
    const elapsed = Date.now() - this.startTime;
    const seconds = Math.floor(elapsed / 1000);
    const ms = elapsed % 1000;
    return `+${seconds}.${ms.toString().padStart(3, "0")}s`;
  }

  ok(message: string): void {
    if (this.logLevel >= LogLevel.INFO) {
      console.log(`[${this.getTimestamp()}] [OK] ${message}`);
    }
  }

  info(message: string): void {
    if (this.logLevel >= LogLevel.INFO) {
      console.log(`[${this.getTimestamp()}] [INFO] ${message}`);
    }
  }

  warn(message: string): void {
    if (this.logLevel >= LogLevel.WARN) {
      console.warn(`[${this.getTimestamp()}] [WARN] ${message}`);
    }
  }

  error(message: string): void {
    if (this.logLevel >= LogLevel.ERROR) {
      console.error(`[${this.getTimestamp()}] [ERROR] ${message}`);
    }
  }

  debug(message: string): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      console.debug(`[${this.getTimestamp()}] [DEBUG] ${message}`);
    }
  }
}
