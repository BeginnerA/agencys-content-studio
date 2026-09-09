import { env } from './env'

type Level = 'debug' | 'info' | 'warn' | 'error'
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const current = LEVELS[(env.logLevel as Level) ?? 'info'] ?? 20

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if ((LEVELS[level] ?? 20) < current) return
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
  }
  if (extra !== undefined) line.extra = extra
  const text = JSON.stringify(line)
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

export interface Logger {
  debug(msg: string, extra?: unknown): void
  info(msg: string, extra?: unknown): void
  warn(msg: string, extra?: unknown): void
  error(msg: string, extra?: unknown): void
  child(scope: string): Logger
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, extra) => emit('debug', scope, msg, extra),
    info: (msg, extra) => emit('info', scope, msg, extra),
    warn: (msg, extra) => emit('warn', scope, msg, extra),
    error: (msg, extra) => emit('error', scope, msg, extra),
    child: (sub) => createLogger(`${scope}:${sub}`),
  }
}
