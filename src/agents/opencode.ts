import { execFile } from "node:child_process";
import type {
  AdapterOptions,
  AgentAdapter,
  AgentName,
  RunHandle,
  RunOptions,
  RunResult,
} from "./types";
import { parseJsonLine, spawnProcess } from "./spawn";
import {
  OPENCODE_MODELS,
  type OpenCodeModel,
} from "./opencode-models.generated";
import { TELEGRAM_FORMAT_INSTRUCTION } from "../bot/format";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MODELS_TIMEOUT_MS = 10_000;

/** Parsea la salida de `opencode models` (líneas `provider/model`). */
export function parseOpencodeModels(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[\w.-]+\/[\w._-]+$/.test(line)),
    ),
  ].sort();
}

/**
 * Eventos NDJSON de `opencode run --format json` (esquema real):
 *
 *   {"type":"step_start", "sessionID":"ses_…", "part":{…}}
 *   {"type":"text",       "sessionID":"ses_…", "part":{"type":"text","text":"…"}}
 *   {"type":"reasoning",  "sessionID":"ses_…", "part":{"type":"reasoning","text":"…"}}
 *   {"type":"step_finish","sessionID":"ses_…", "part":{"reason":"stop","cost":0,"tokens":{…}}}
 */
interface OpencodeEvent {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    sessionID?: string;
    reason?: string;
    cost?: number;
    tokens?: { total?: number; input?: number; output?: number };
  };
}

export interface OpencodeAdapterConfig extends AdapterOptions {
  bin?: string;
  /** Modelos ofrecidos por /model. Si se omite, se leen de `opencode models`. */
  models?: OpenCodeModel[];
  /** Auto-aprueba permisos (--auto). Sin esto, las acciones sensibles se deniegan en headless. */
  autoApprove?: boolean;
  /** Pide bloques de razonamiento al CLI (--thinking). Default: true. */
  thinking?: boolean;
}

export interface ParsedOpencodeEvent {
  sessionId?: string;
  text?: string;
  /** Razonamiento emitido en este evento (part.type "reasoning"). */
  thinking?: string;
  costUsd?: number;
}

/** Parser de los eventos NDJSON de `opencode run --format json`. */
export function parseOpencodeEvent(line: string): ParsedOpencodeEvent {
  const event = parseJsonLine<OpencodeEvent>(line);
  if (!event) return {};

  const parsed: ParsedOpencodeEvent = {};
  const sessionId = event.sessionID ?? event.part?.sessionID;
  if (sessionId) parsed.sessionId = sessionId;

  // El texto útil llega en eventos {"type":"text"} con part.text completo.
  if (event.type === "text" && typeof event.part?.text === "string") {
    parsed.text = event.part.text;
  }

  // El razonamiento llega como {"type":"reasoning"} con part.text completo
  // (con --thinking; el CLI lo oculta por defecto).
  if (event.type === "reasoning" && typeof event.part?.text === "string") {
    parsed.thinking = event.part.text;
  }

  // step_finish trae el coste acumulado del run.
  if (event.type === "step_finish" && typeof event.part?.cost === "number") {
    parsed.costUsd = event.part.cost;
  }

  return parsed;
}

/** Flags de `opencode run` según opciones y modo. Función pura (testeable). */
export function buildOpencodeArgs(
  options: Pick<
    RunOptions,
    "model" | "sessionId" | "mode" | "files" | "prompt" | "cwd" | "effort"
  >,
  config: OpencodeAdapterConfig = {},
): string[] {
  const args = ["run", "--format", "json"];
  if (options.model) args.push("--model", options.model);
  if (options.sessionId) args.push("--session", options.sessionId);
  // El CLI oculta el thinking por defecto; --thinking lo incluye en el stream.
  if (config.thinking !== false) args.push("--thinking");
  // --variant es el reasoning effort provider-specific del CLI.
  if (options.effort) args.push("--variant", options.effort);
  // Plan → agente read-only de opencode; edit → build (default) + --auto si aplica.
  if ((options.mode ?? "edit") === "plan") {
    args.push("--agent", "plan");
  } else if (config.autoApprove) {
    args.push("--auto");
  }
  for (const file of options.files ?? []) args.push("--file", file);

  const cwd = config.cwd ?? options.cwd;
  if (cwd) args.push("--dir", cwd);

  // El formato Telegram va antepuesto: opencode no tiene --append-system-prompt.
  const prompt = `${TELEGRAM_FORMAT_INSTRUCTION}\n\n${options.prompt}`;

  // El mensaje es posicional y va al final.
  args.push(prompt);
  return args;
}

export class OpencodeAdapter implements AgentAdapter {
  readonly name: AgentName = "opencode";

  private modelsCache?: string[];

  constructor(private readonly config: OpencodeAdapterConfig = {}) {}

  /**
   * Modelos disponibles, en cascada:
   * config explícita → `opencode models` (cacheado) → lista generada.
   */
  async listModels(): Promise<string[]> {
    if (this.config.models?.length) return [...this.config.models];
    if (this.modelsCache) return this.modelsCache;

    try {
      const stdout = await this.fetchModelsFromCli();
      const models = parseOpencodeModels(stdout);
      if (models.length > 0) {
        this.modelsCache = models;
        return models;
      }
    } catch (error) {
      console.warn("[telegram2agent] `opencode models` falló:", error);
    }
    return [...OPENCODE_MODELS];
  }

  private fetchModelsFromCli(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.config.bin ?? "opencode",
        ["models"],
        { timeout: MODELS_TIMEOUT_MS },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  }

  run(options: RunOptions): RunHandle {
    let kill: (() => Promise<void>) | undefined;

    const resultPromise = new Promise<RunResult>((resolve, reject) => {
      const args = buildOpencodeArgs(options, this.config);

      let settled = false;
      const timerRef: { current?: ReturnType<typeof setTimeout> } = {};
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        fn();
      };

      let sessionId: string | undefined;
      let costUsd: number | undefined;
      const texts: string[] = [];
      const thinkingParts: string[] = [];

      const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const { close, controller } = spawnProcess(
        this.config.bin ?? "opencode",
        args,
        {
          cwd: this.config.cwd ?? options.cwd,
          onStdoutLine: (line) => {
            const parsed = parseOpencodeEvent(line);
            if (parsed.sessionId) sessionId = parsed.sessionId;
            if (parsed.costUsd !== undefined) costUsd = parsed.costUsd;
            if (parsed.text !== undefined && !texts.includes(parsed.text)) {
              texts.push(parsed.text);
              // El texto parcial acumulado alimenta el streaming del chat.
              options.onText?.(texts.join("\n\n"));
            }
            if (
              parsed.thinking !== undefined &&
              !thinkingParts.includes(parsed.thinking)
            ) {
              thinkingParts.push(parsed.thinking);
              options.onThinking?.(thinkingParts.join("\n\n"));
            }
          },
          onStderrLine: (line) => {
            if (line) process.stderr.write(`[opencode] ${line}\n`);
          },
        },
      );

      timerRef.current = setTimeout(() => {
        void controller.kill();
        finish(() =>
          reject(new Error(`opencode excedió el timeout de ${timeoutMs}ms`)),
        );
      }, timeoutMs);

      kill = () => controller.kill();

      // El prompt va como argumento; sin TTY, opencode esperaría stdin → cerramos.
      controller.endStdin();

      void close.then(({ code }) => {
        // Pequeña espera por si llegan eventos de cierre tras el exit.
        setTimeout(() => {
          finish(() => {
            const text = texts.join("\n\n");
            if (code !== 0 && code !== null && text === "") {
              reject(new Error(`opencode terminó con código ${code}`));
            } else {
              resolve({
                ok: code === 0 || text !== "",
                text,
                sessionId,
                costUsd,
                thinking:
                  thinkingParts.length > 0
                    ? thinkingParts.join("\n\n")
                    : undefined,
              });
            }
          });
        }, 500);
      });
    });

    return {
      result: () => resultPromise,
      cancel: async () => {
        await kill?.();
      },
    };
  }
}
