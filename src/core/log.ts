import type { ErrorCode, LogEvent, Logger } from './types';

const MAX_EVENTS = 200;
const DEBUG = true;

const ring: LogEvent[] = [];
let sink: Logger | null = null;

/** 生产环境只打层名/耗时/行数，绝不打整段字幕内容。 */
export function setLogSink(fn: Logger | null): void {
  sink = fn;
}

export const log: Logger = (event) => {
  const entry: LogEvent = { at: Date.now(), ...event };
  ring.push(entry);
  if (ring.length > MAX_EVENTS) ring.shift();
  if (sink) {
    try {
      sink(event);
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }
  if (DEBUG) {
    const parts = [`[ytt]`, entry.source ?? 'core', entry.code];
    if (typeof entry.ms === 'number') parts.push(`${entry.ms}ms`);
    if (entry.detail) parts.push(entry.detail);
    console.debug(...parts);
  }
};

export function recentEvents(): LogEvent[] {
  return [...ring];
}

export function clearEvents(): void {
  ring.length = 0;
}

export function makeLogger(scope: string): Logger {
  return (event) => log({ ...event, meta: { ...event.meta, scope } });
}

export function failureCodeOf(error: unknown): ErrorCode {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code as ErrorCode;
  }
  return 'UNKNOWN';
}
