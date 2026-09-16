import { Injectable, LoggerService } from '@nestjs/common';
import { redact } from './redaction';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly level: LogLevel;
  readonly at: string;
  readonly message: string;
  readonly context?: string;
  readonly detail?: unknown;
}

/**
 * Structured logger that redacts every field before it is emitted.
 *
 * Errors are reduced to their CLASS and message; a stack can carry absolute
 * paths and a message can carry a URL, so both go through redaction too.
 */
@Injectable()
export class StructuredLogger implements LoggerService {
  private sink: (record: LogRecord) => void = (record) => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };

  /** Test seam: capture records instead of writing them. */
  setSink(sink: (record: LogRecord) => void): void {
    this.sink = sink;
  }

  private emit(
    level: LogLevel,
    message: unknown,
    context?: string,
    detail?: unknown,
  ): void {
    const record: LogRecord = {
      level,
      at: new Date().toISOString(),
      message: String(redact(String(message))),
      ...(context === undefined ? {} : { context }),
      ...(detail === undefined ? {} : { detail: redact(detail) }),
    };
    this.sink(record);
  }

  log(message: unknown, context?: string): void {
    this.emit('info', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.emit('debug', message, context);
  }

  warn(message: unknown, context?: string): void {
    this.emit('warn', message, context);
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    this.emit('error', message, context ?? stackOrContext);
  }

  /** Records an exception as { class, message } — never the stack. */
  failure(message: string, cause: unknown, context?: string): void {
    this.emit('error', message, context, describeError(cause));
  }

  detail(
    level: LogLevel,
    message: string,
    detail: unknown,
    context?: string,
  ): void {
    this.emit(level, message, context, detail);
  }
}

export function describeError(cause: unknown): {
  class: string;
  message: string;
} {
  if (cause instanceof Error) {
    return { class: cause.constructor.name, message: cause.message };
  }
  return { class: typeof cause, message: String(cause) };
}

/** Error CLASS only — what the outbox records about a failed attempt. */
export function errorClass(cause: unknown): string {
  return cause instanceof Error ? cause.constructor.name : typeof cause;
}
