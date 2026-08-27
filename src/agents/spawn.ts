import { spawn } from "node:child_process";

export interface ProcessController {
  writeStdin(line: string): void;
  endStdin(): void;
  kill(): Promise<void>;
}

export interface RunningProcess {
  /** Se resuelve cuando el proceso termina. */
  close: Promise<{ code: number | null }>;
  controller: ProcessController;
}

export function spawnProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
  },
): RunningProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrChunks: string[] = [];
  let stdoutBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf("\n");
    while (index !== -1) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.length > 0) options.onStdoutLine?.(line);
      index = stdoutBuffer.indexOf("\n");
    }
  });

  // Escribir o cerrar stdin de un proceso que ya terminó emite EPIPE. No es
  // accionable aquí: la muerte del proceso ya se propaga por `close`, y sin
  // este handler el error subiría como excepción no capturada.
  child.stdin.on("error", () => {});

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
    options.onStderrLine?.(chunk.trimEnd());
  });

  const close = new Promise<{ code: number | null }>((resolve) => {
    child.on("close", (code) => resolve({ code }));
    child.on("error", () => resolve({ code: -1 }));
  });

  const controller: ProcessController = {
    writeStdin(line: string) {
      if (child.stdin.writableEnded) return;
      child.stdin.write(`${line}\n`);
    },
    endStdin() {
      if (child.stdin.writableEnded) return;
      child.stdin.end();
    },
    async kill() {
      child.kill("SIGTERM");
      const forced = setTimeout(() => child.kill("SIGKILL"), 5000);
      await close;
      clearTimeout(forced);
    },
  };

  return { close, controller };
}

export function parseJsonLine<T>(line: string): T | undefined {
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}

/** Extrae rutas marcadas con `FILE:` en el texto del agente. */
export function extractFileRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/^FILE:\s*(\S+)\s*$/gm)) {
    const ref = match[1];
    if (ref) refs.add(ref);
  }
  return [...refs];
}
