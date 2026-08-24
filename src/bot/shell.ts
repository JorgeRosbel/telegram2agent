import { spawn, type ChildProcess } from "node:child_process";

export interface ShellResult {
  /** Comando ejecutado (sin el prefijo "!"). */
  command: string;
  /** Código de salida; null si el proceso murió por señal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** true si se superó el timeout o se canceló explícitamente. */
  killed: boolean;
  /** Señal con la que terminó el proceso (SIGTERM/SIGKILL), si aplica. */
  signal?: string;
  /** true si la salida se recortó por superar maxOutputBytes. */
  outputTruncated: boolean;
}

export interface ShellOptions {
  /** Directorio donde se ejecuta el comando. */
  cwd: string;
  /** Timeout en ms; 0 desactiva. Default: 300_000 (5 min). */
  timeoutMs?: number;
  /** Tope de captura por stream. Default: 512 KiB. */
  maxOutputBytes?: number;
}

export interface ShellHandle {
  result(): Promise<ShellResult>;
  /** Mata el árbol de procesos (SIGTERM → SIGKILL). */
  cancel(): void;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * Extrae el comando de un mensaje que empieza por "!". Devuelve undefined
 * si el mensaje no es un comando de shell o está vacío.
 */
export function parseShellCommand(text: string): string | undefined {
  if (!text.startsWith("!")) return undefined;
  const command = text.slice(1).trim();
  return command.length > 0 ? command : undefined;
}

/** Captura un stream acotado a maxBytes. */
function cappedStream(maxBytes: number): {
  push: (chunk: Buffer) => void;
  text: () => string;
  truncated: () => boolean;
} {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      if (total >= maxBytes) {
        truncated = true;
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
      if (total > maxBytes) truncated = true;
    },
    text: () => Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8"),
    truncated: () => truncated,
  };
}

/**
 * Ejecuta un comando de shell en `cwd` (equivalente a escribirlo en la
 * terminal) y captura su salida. El proceso corre en su propio grupo para
 * poder matar el árbol completo en timeout o cancelación.
 */
export function runShell(command: string, options: ShellOptions): ShellHandle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  const out = cappedStream(maxOutputBytes);
  const err = cappedStream(maxOutputBytes);

  const child: ChildProcess = spawn(command, {
    cwd: options.cwd,
    shell: true,
    detached: true, // líder de grupo → kill(-pid) mata el árbol
    stdio: ["ignore", "pipe", "pipe"],
  });

  let killed = false;
  let timedOut = false;

  child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

  function killTree(signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // El proceso ya terminó.
    }
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
    }, timeoutMs);
  }

  let resolveResult!: (result: ShellResult) => void;
  const resultPromise = new Promise<ShellResult>((resolve) => {
    resolveResult = resolve;
  });

  let settled = false;
  function finish(result: ShellResult): void {
    if (settled) return;
    settled = true;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    resolveResult(result);
  }

  child.on("error", (error: NodeJS.ErrnoException) => {
    finish({
      command,
      exitCode: -1,
      stdout: out.text(),
      stderr: err.text() || String(error.message ?? error),
      durationMs: Date.now() - startedAt,
      killed,
      outputTruncated: out.truncated() || err.truncated(),
    });
  });

  child.on("close", (code, signal) => {
    finish({
      command,
      exitCode: code,
      stdout: out.text(),
      stderr: err.text(),
      durationMs: Date.now() - startedAt,
      killed: killed || timedOut,
      signal: signal ?? undefined,
      outputTruncated: out.truncated() || err.truncated(),
    });
  });

  return {
    result: () => resultPromise,
    cancel() {
      killed = true;
      killTree("SIGTERM");
      const grace = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      grace.unref();
    },
  };
}
