/**
 * logger.ts — Minimal level-based logger for Fractal.
 *
 * Reads FRACTAL_LOG_LEVEL from env (debug | info | warn | error, default: info).
 * Each logger is tagged with a component name for easy filtering.
 *
 * Output format: [LEVEL] [tag] message
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: Level = (() => {
  const env = (process.env["FRACTAL_LOG_LEVEL"] ?? "info").toLowerCase();
  if (env in LEVELS) return env as Level;
  return "info";
})();

export interface Logger {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export function createLogger(tag: string): Logger {
  function log(level: Level, msg: string): void {
    if (LEVELS[level] < LEVELS[currentLevel]) return;
    const out = `[${level}] [${tag}] ${msg}`;
    if (level === "error") {
      console.error(out);
    } else if (level === "warn") {
      console.warn(out);
    } else {
      console.log(out);
    }
  }

  return {
    debug: (msg: string) => log("debug", msg),
    info: (msg: string) => log("info", msg),
    warn: (msg: string) => log("warn", msg),
    error: (msg: string) => log("error", msg),
  };
}
