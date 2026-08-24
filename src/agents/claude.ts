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

const DEFAULT_MODELS = ["opus", "sonnet", "haiku"];
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Modelos con alias nativo en `claude --model`; cualquier string es válido. */
export const KNOWN_CLAUDE_MODELS = ["opus", "sonnet", "haiku"] as const;
export type KnownClaudeModel = (typeof KNOWN_CLAUDE_MODELS)[number];
export type ClaudeModel = KnownClaudeModel | (string & {});

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: unknown };
  message?: { content?: Array<{ type?: string; text?: string }> };
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
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text) partialText += `${block.text}\n`;
    }
    if (partialText) parsed.text = partialText.trim();
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
    "model" | "sessionId" | "mode" | "onPermission" | "prompt"
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

  run(options: RunOptions): RunHandle {
    let kill: (() => Promise<void>) | undefined;
    let permissionSink:
      ((requestId: string, allow: boolean) => void) | undefined;

    const resultPromise = new Promise<RunResult>((resolve, reject) => {
      const args = buildClaudeArgs(options, this.config);

      let settled = false;
      const finish = (fail: Error | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (fail) {
          reject(fail);
        } else if (current) {
          resolve(current);
        } else {
          reject(new Error("claude terminó sin resultado"));
        }
      };

      let current: RunResult | undefined;
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
            if (parsed.result) {
              current = parsed.result;
              finish(undefined);
            }
          },
          onStderrLine: (line) => {
            if (line) process.stderr.write(`[claude] ${line}\n`);
          },
        },
      );

      const timer = setTimeout(() => {
        void controller.kill();
        finish(new Error(`claude excedió el timeout de ${timeoutMs}ms`));
      }, timeoutMs);

      kill = () => controller.kill();
      permissionSink = (requestId, allow) =>
        controller.writeStdin(buildControlResponse(requestId, allow));

      void close.then(({ code }) => {
        setTimeout(() => {
          if (!settled) {
            finish(
              current
                ? undefined
                : new Error(
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

    return {
      result: () => resultPromise,
      cancel: async () => {
        await kill?.();
      },
    };
  }
}
