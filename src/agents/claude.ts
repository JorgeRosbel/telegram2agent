import type {
  AdapterOptions,
  AgentAdapter,
  AgentName,
  PermissionRequest,
  RunHandle,
  RunOptions,
  RunResult,
} from "./types";
import { parseJsonLine, spawnProcess } from "./spawn";
import { TELEGRAM_FORMAT_INSTRUCTION } from "../bot/format";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_USAGE_LIMIT_RETRY_MS = 10 * 60 * 1000;

/**
 * Detecta si un texto de error es específicamente "se agotó el límite de
 * uso del plan actual" (la ventana de 5h/semanal de la suscripción), y no
 * cualquier otro error (auth, red, bug del agente…). Confirmado como frase
 * literal del CLI (`usage limit reached`) inspeccionando el binario.
 */
export function isUsageLimitError(text: string | undefined): boolean {
  return text !== undefined && /usage limit reached/i.test(text);
}

/**
 * Alias nativos de `claude --model` (verificados contra `claude --help` y el
 * binario de la CLI instalada; no hay `claude models` para listarlos en vivo
 * como con OpenCode). Cualquier string es válido igualmente: IDs versionados
 * (p. ej. `claude-opus-5`) no se tipan aquí porque cambian con cada release
 * y quedarían obsoletos.
 */
export const KNOWN_CLAUDE_MODELS = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "opusplan",
  "best",
] as const;
export type KnownClaudeModel = (typeof KNOWN_CLAUDE_MODELS)[number];
export type ClaudeModel = KnownClaudeModel | (string & {});

const DEFAULT_MODELS: string[] = [...KNOWN_CLAUDE_MODELS];

/**
 * Niveles válidos de `claude --effort` — choices list fija y verificada
 * contra `claude --help` de la CLI instalada (a diferencia de los modelos,
 * este set es estable entre releases).
 */
export const KNOWN_CLAUDE_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type KnownClaudeEffort = (typeof KNOWN_CLAUDE_EFFORTS)[number];
export type ClaudeEffort = KnownClaudeEffort | (string & {});

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: unknown };
  message?: {
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
}

export interface ClaudeAdapterConfig extends AdapterOptions {
  /** Modelos ofrecidos por /model (alias válidos para `claude --model`). */
  models?: string[];
  bin?: string;
}

function summarizeInput(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 200);
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const candidate =
      record.command ?? record.file_path ?? record.path ?? record.pattern;
    if (typeof candidate === "string") return candidate.slice(0, 200);
    return JSON.stringify(record).slice(0, 200);
  }
  return "";
}

export interface ParsedClaudeEvent {
  sessionId?: string;
  text?: string;
  /** Razonamiento emitido en este evento (bloques thinking del assistant). */
  thinking?: string;
  permission?: { requestId: string; request: PermissionRequest };
  result?: RunResult;
}

/** Parser puro de eventos NDJSON de `claude -p --output-format stream-json`. */
export function parseClaudeEvent(line: string): ParsedClaudeEvent {
  const event = parseJsonLine<ClaudeEvent>(line);
  if (!event) return {};

  const parsed: ParsedClaudeEvent = {};
  if (event.session_id) parsed.sessionId = event.session_id;

  if (
    event.type === "control_request" &&
    event.request?.subtype === "can_use_tool" &&
    event.request_id
  ) {
    parsed.permission = {
      requestId: event.request_id,
      request: {
        tool: event.request.tool_name ?? "desconocida",
        summary: summarizeInput(event.request.input),
      },
    };
    return parsed;
  }

  if (event.type === "assistant") {
    let partialText = "";
    let partialThinking = "";
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text) partialText += `${block.text}\n`;
      if (block.type === "thinking" && block.thinking) {
        partialThinking += `${block.thinking}\n`;
      }
    }
    if (partialText) parsed.text = partialText.trim();
    if (partialThinking) parsed.thinking = partialThinking.trim();
    return parsed;
  }

  if (event.type === "result") {
    parsed.result = {
      ok: !event.is_error,
      text: event.result ?? "",
      sessionId: event.session_id,
      costUsd: event.total_cost_usd,
      durationMs: event.duration_ms,
    };
  }
  return parsed;
}

/** Línea `control_response` para responder a una petición de permiso. */
export function buildControlResponse(
  requestId: string,
  allow: boolean,
): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: allow
        ? { behavior: "allow", updatedInput: {} }
        : {
            behavior: "deny",
            message: "Denegado por el usuario desde Telegram.",
          },
    },
  });
}

export const FILE_PROTOCOL_INSTRUCTION = [
  "",
  "ENTREGA DE ARCHIVOS — protocolo obligatorio:",
  "Tú NO puedes enviar mensajes ni adjuntos por tu cuenta; el usuario te lee",
  "a través de un puente de Telegram. Cuando el usuario pida un archivo,",
  "imagen o resultado tangible (screenshots, gráficas, PDFs…):",
  "1. Guárdalo en disco.",
  "2. Termina tu respuesta con UNA LÍNEA POR ARCHIVO, exactamente así:",
  "   FILE: /ruta/absoluta/al/archivo",
  'Nunca digas "te lo adjunto" o "ya lo envié": la línea FILE: es lo único',
  "que hace llegar el archivo al usuario.",
].join("\n");

/** Prompt final: mensaje del usuario + adjuntos + protocolo FILE:. */
export function buildPrompt(
  options: Pick<RunOptions, "prompt" | "files">,
): string {
  const parts = [options.prompt];
  if (options.files?.length) {
    parts.push(
      `\nArchivos adjuntos del usuario:\n${options.files.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  parts.push(FILE_PROTOCOL_INSTRUCTION);
  return parts.join("\n");
}

/** Flags de `claude -p` según opciones y modo. Función pura (testeable). */
export function buildClaudeArgs(
  options: Pick<
    RunOptions,
    "model" | "sessionId" | "mode" | "onPermission" | "prompt" | "effort"
  >,
  config: ClaudeAdapterConfig = {},
): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    // Formato Telegram sin tocar el mensaje del usuario.
    "--append-system-prompt",
    TELEGRAM_FORMAT_INSTRUCTION,
  ];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.sessionId) args.push("--resume", options.sessionId);

  const mode = options.mode ?? "edit";
  if (mode === "plan") {
    // Plan: solo lectura; no hay nada sensible que aprobar.
    args.push("--permission-mode", "plan");
  } else if (!options.onPermission) {
    args.push("--permission-mode", config.permissionMode ?? "acceptEdits");
  }
  return args;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name: AgentName = "claude";

  constructor(private readonly config: ClaudeAdapterConfig = {}) {}

  async listModels(): Promise<string[]> {
    return this.config.models ?? DEFAULT_MODELS;
  }

  /** Un único intento: spawnea `claude` una vez y resuelve/rechaza con el resultado. */
  private attemptOnce(options: RunOptions): {
    result: Promise<RunResult>;
    kill: () => Promise<void>;
  } {
    let kill: (() => Promise<void>) | undefined;
    let permissionSink:
      ((requestId: string, allow: boolean) => void) | undefined;

    const result = new Promise<RunResult>((resolve, reject) => {
      const args = buildClaudeArgs(options, this.config);

      let settled = false;
      let stderrText = "";
      const timerRef: { current?: ReturnType<typeof setTimeout> } = {};
      const finish = (fail: Error | undefined): void => {
        if (settled) return;
        settled = true;
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        if (fail) {
          reject(fail);
        } else if (current) {
          resolve(current);
        } else {
          reject(new Error("claude terminó sin resultado"));
        }
      };

      let current: RunResult | undefined;
      const thinking: string[] = [];
      const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const { close, controller } = spawnProcess(
        this.config.bin ?? "claude",
        args,
        {
          cwd: this.config.cwd ?? options.cwd,
          onStdoutLine: (line) => {
            const parsed = parseClaudeEvent(line);
            if (parsed.permission && options.onPermission) {
              const { requestId, request } = parsed.permission;
              void options
                .onPermission(request)
                .catch(() => false)
                .then((allowed) => permissionSink?.(requestId, allowed));
              return;
            }
            if (parsed.text) options.onText?.(parsed.text);
            if (parsed.thinking && !thinking.includes(parsed.thinking)) {
              thinking.push(parsed.thinking);
              options.onThinking?.(thinking.join("\n\n"));
            }
            if (parsed.result) {
              current = {
                ...parsed.result,
                thinking:
                  thinking.length > 0 ? thinking.join("\n\n") : undefined,
              };
              finish(undefined);
            }
          },
          onStderrLine: (line) => {
            if (line) {
              stderrText += `${line}\n`;
              process.stderr.write(`[claude] ${line}\n`);
            }
          },
        },
      );

      timerRef.current = setTimeout(() => {
        void controller.kill();
        finish(new Error(`claude excedió el timeout de ${timeoutMs}ms`));
      }, timeoutMs);

      kill = () => controller.kill();
      permissionSink = (requestId, allow) =>
        controller.writeStdin(buildControlResponse(requestId, allow));

      void close.then(({ code }) => {
        setTimeout(() => {
          if (!settled) {
            // Un fallo duro (sin evento `result`) suele imprimir el motivo
            // solo en stderr — lo incluimos para poder detectar ahí el
            // límite de uso agotado, no solo en un `result` con is_error.
            finish(
              current
                ? undefined
                : new Error(
                    stderrText.trim() ||
                      `claude terminó con código ${code ?? 0} sin resultado`,
                  ),
            );
          }
        }, 500);
      });

      // Mensaje inicial por stdin (protocolo stream-json).
      controller.writeStdin(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: buildPrompt(options) }],
          },
        }),
      );
    });

    return { result, kill: () => kill?.() ?? Promise.resolve() };
  }

  run(options: RunOptions): RunHandle {
    let cancelled = false;
    let killCurrent: () => Promise<void> = () => Promise.resolve();
    let unblockWait: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retryMs =
      this.config.usageLimitRetryMs ?? DEFAULT_USAGE_LIMIT_RETRY_MS;

    const resultPromise = (async (): Promise<RunResult> => {
      for (let attempt = 1; ; attempt++) {
        if (cancelled) throw new Error("Ejecución cancelada.");

        const current = this.attemptOnce(options);
        killCurrent = current.kill;
        let outcome: RunResult | Error;
        try {
          outcome = await current.result;
        } catch (error) {
          outcome = error as Error;
        }

        const failureText =
          outcome instanceof Error
            ? outcome.message
            : outcome.ok
              ? undefined
              : outcome.text;

        if (!cancelled && isUsageLimitError(failureText)) {
          options.onUsageLimitWait?.({ attempt, retryInMs: retryMs });
          await new Promise<void>((resolve) => {
            unblockWait = resolve;
            retryTimer = setTimeout(resolve, retryMs);
          });
          retryTimer = undefined;
          unblockWait = undefined;
          continue;
        }

        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
    })();

    return {
      result: () => resultPromise,
      cancel: async () => {
        cancelled = true;
        if (retryTimer !== undefined) clearTimeout(retryTimer);
        unblockWait?.();
        await killCurrent();
      },
    };
  }
}
