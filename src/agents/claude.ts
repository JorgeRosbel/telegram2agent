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
/** Margen para que `claude` salga solo tras el EOF antes de forzar SIGTERM. */
const REAP_GRACE_MS = 10 * 1000;

/**
 * Frases con las que el CLI dice "no puedes seguir ahora mismo, pero podrás
 * más tarde". Verificadas contra el binario instalado (`claude` 2.1.x), que
 * construye el aviso con la plantilla `You've hit your ${scope}${…}` — de ahí
 * salen `session limit`, `weekly limit`, `fast limit`, `monthly limit` y el
 * escueto `your limit`, todas seguidas de `· resets <hora>`.
 *
 * Ojo al ampliar esto: un falso negativo hace que el run falle en vez de
 * esperar (que es lo que quemaba una issue tras otra durante un límite de
 * sesión), y un falso positivo lo deja dormido en vez de fallar.
 */
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit reached/i,
  /you'?ve hit your [^\n]{0,40}limit/i,
  /\b(?:session|weekly|5-hour|five-hour|opus|fast) limit\b[^\n]{0,60}\b(?:reached|resets?)\b/i,
  /\brate[ _-]?limit(?:ed)?\b/i,
];

/**
 * Un tope de gasto no se levanta solo: necesita que un humano suba el límite
 * o recargue saldo. Dormir aquí dejaría el run colgado indefinidamente, así
 * que se trata como fallo duro pese a contener la palabra "limit".
 */
const BILLING_LIMIT_PATTERN =
  /\bspend limit\b|\bcredit balance too low\b|\bbilling_error\b/i;

/**
 * Detecta si un fallo es "se agotó el límite de uso" (ventana de 5h, semanal
 * o rate limit del API) y no otro error (auth, red, bug del agente…), en cuyo
 * caso el run debe dormir y reintentar en lugar de rendirse.
 */
export function isUsageLimitError(text: string | undefined): boolean {
  if (text === undefined) return false;
  if (BILLING_LIMIT_PATTERN.test(text)) return false;
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Extrae el momento de reset que el CLI adjunta al aviso
 * (`… · resets 3:30am (Europe/Madrid)`), para poder decírselo al usuario.
 */
export function parseUsageLimitReset(
  text: string | undefined,
): string | undefined {
  const match = text?.match(
    /resets\s+([^\n·]{1,40}?)\s*$|resets\s+([^\n·]{1,40})/i,
  );
  const raw = (match?.[1] ?? match?.[2])?.trim();
  return raw && raw.length > 0 ? raw : undefined;
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
      const reapRef: { current?: () => void } = {};
      const finish = (fail: Error | undefined): void => {
        if (settled) return;
        settled = true;
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        reapRef.current?.();
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

      // A diferencia de opencode, aquí stdin NO puede cerrarse al arrancar: el
      // protocolo de permisos responde por esa misma tubería. Pero con
      // `--input-format stream-json` la CLI sigue esperando más mensajes
      // después de emitir su `result`, así que sin EOF el proceso no termina
      // jamás. Cada turno dejaba vivo un `claude` completo: encadenar pasos
      // (o reintentar por límite de uso) acababa agotando la RAM de la
      // máquina. Cerramos stdin en cuanto el turno se asienta y, si aun así
      // no sale, lo matamos.
      const reap = (): void => {
        controller.endStdin();
        const forced = setTimeout(() => void controller.kill(), REAP_GRACE_MS);
        void close.then(() => clearTimeout(forced));
      };
      reapRef.current = reap;
      // `finish` puede haberse disparado ya si el `result` llegó de forma
      // síncrona durante el spawn, antes de que `reapRef` estuviera puesto.
      if (settled) reap();

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
          options.onUsageLimitWait?.({
            attempt,
            retryInMs: retryMs,
            resetsAt: parseUsageLimitReset(failureText),
          });
          await new Promise<void>((resolve) => {
            unblockWait = resolve;
            retryTimer = setTimeout(resolve, retryMs);
          });
          retryTimer = undefined;
          unblockWait = undefined;
          options.onUsageLimitResume?.({ attempt });
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
