import path from "node:path";
import type { Bot } from "grammy";
import {
  ClaudeAdapter,
  type ClaudeAdapterConfig,
  type ClaudeModel,
} from "./agents/claude";
import { OpencodeAdapter, type OpencodeAdapterConfig } from "./agents/opencode";
import type { OpenCodeModel } from "./agents/opencode-models.generated";
import type {
  AgentAdapter,
  AgentMode,
  AgentName,
  RunOptions,
  RunResult,
} from "./agents/types";
import { createTelegramBot } from "./bot/telegram";
import { sanitizeForTelegram } from "./bot/format";
import { ApprovalBridge } from "./tasks/approvals";
import { TaskRegistry, type Task } from "./tasks/registry";
import { StateStore } from "./state/store";
import { DEFAULT_DB_FILENAME } from "./bot/telegram";

export { VERSION } from "./version";
export { ClaudeAdapter } from "./agents/claude";
export { OpencodeAdapter, parseOpencodeModels } from "./agents/opencode";
export { sanitizeForTelegram } from "./bot/format";
export { collectOutboundFiles, resolveWithin, sendFiles } from "./bot/media";
export { parseShellCommand, runShell } from "./bot/shell";
export type { ShellHandle, ShellOptions, ShellResult } from "./bot/shell";
export type {
  AgentMode,
  AgentName,
  PermissionRequest,
  RunHandle,
  RunOptions,
  RunResult,
} from "./agents/types";
export type { ClaudeModel, KnownClaudeModel } from "./agents/claude";
export type {
  OpenCodeModel,
  KnownOpenCodeModel,
} from "./agents/opencode-models.generated";
export type { Task, TaskStatus } from "./tasks/registry";

/** Modelo de cualquier agente: autocomplete + cualquier string válido. */
export type AnyModel = ClaudeModel | OpenCodeModel;

export interface BotConfig {
  /** Token del bot de Telegram (@BotFather). */
  token: string;
  /**
   * Chat IDs (número) o usernames ("@usuario") con acceso. Todo lo demás
   * se ignora silenciosamente: esta es la barrera de seguridad principal.
   */
  allow: Array<number | string>;
  /** Directorio de trabajo de los agentes. Default: process.cwd(). */
  cwd?: string;
  /** Ruta del estado persistente. Default: `<cwd>/.telegram2agent.json`. */
  dbPath?: string;
  defaults?: {
    agent?: AgentName;
    /** Autocomplete con los modelos conocidos; acepta cualquier string. */
    model?: Partial<Record<AgentName, AnyModel>>;
    /** 'plan' = solo lectura · 'edit' = aplica cambios (default). */
    mode?: AgentMode;
  };
  /** Timeout para aprobar acciones sensibles desde Telegram. Default: 120s. */
  approvalTimeoutMs?: number;
  /** Timeout máximo por ejecución del agente. Default: 30 min. */
  taskTimeoutMs?: number;
  /** Mensajes "!cmd" se ejecutan en la terminal del proyecto. Default: true. */
  shellEnabled?: boolean;
  /** Timeout de los comandos "!cmd". Default: 300_000 (5 min). */
  shellTimeoutMs?: number;
  claude?: ClaudeAdapterConfig;
  opencode?: OpencodeAdapterConfig;
}

export interface T2ABot {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Pregunta síncrona al agente activo y devuelve la respuesta completa. */
  ask(prompt: string, options?: AskOptions): Promise<RunResult>;
  /**
   * Lanza una tarea en segundo plano. El chat recibe notificación automática
   * al terminar; puedes colgar callbacks con task.onDone().
   */
  run(prompt: string, options?: RunTaskOptions): Task | undefined;
  /** Envía un aviso directo al primer chat permitido. */
  notify(text: string): Promise<void>;
  readonly registry: TaskRegistry;
  /** Instancia grammY subyacente, para extender con tus propios handlers. */
  readonly grammy: Bot;
}

export interface AskOptions extends Pick<RunOptions, "onText"> {
  agent?: AgentName;
  model?: string;
  mode?: AgentMode;
}

export interface RunTaskOptions extends AskOptions {
  /** Chat al que se notifica el resultado. Default: el primero de `allow`. */
  chatId?: number | string;
}

/**
 * Punto de entrada: crea el bot de Telegram + los adapters de agentes,
 * con allowlist, streaming, aprobaciones y tareas en segundo plano.
 */
export function createBot(config: BotConfig): T2ABot {
  if (!config.allow || config.allow.length === 0) {
    throw new Error("createBot requiere `allow` con al menos un chat ID.");
  }

  const cwd = config.cwd ?? process.cwd();
  const dbPath = config.dbPath ?? path.join(cwd, DEFAULT_DB_FILENAME);

  const claude = new ClaudeAdapter({ cwd, ...config.claude });
  const opencode = new OpencodeAdapter({ cwd, ...config.opencode });
  const adapters: Record<AgentName, AgentAdapter> = { claude, opencode };

  const store = new StateStore(dbPath, {
    agent: config.defaults?.agent,
    models: config.defaults?.model,
    modes: config.defaults?.mode
      ? { [config.defaults.agent ?? "claude"]: config.defaults.mode }
      : {},
  });

  const registry = new TaskRegistry(config.taskTimeoutMs ?? 30 * 60 * 1000);
  const approvals = new ApprovalBridge(config.approvalTimeoutMs ?? 120_000);

  void store.load();

  const grammy = createTelegramBot({
    token: config.token,
    allow: config.allow,
    cwd,
    adapters,
    store,
    registry,
    approvals,
    approvalTimeoutMs: config.approvalTimeoutMs,
    defaultMode: config.defaults?.mode,
    shellEnabled: config.shellEnabled,
    shellTimeoutMs: config.shellTimeoutMs,
  });

  function resolveAgent(agent?: AgentName): AgentAdapter {
    return adapters[agent ?? store.agent];
  }

  function primaryChatId(): number {
    const first = config.allow[0];
    return typeof first === "number" ? first : 0;
  }

  async function execute(
    prompt: string,
    options: AskOptions,
  ): Promise<RunResult> {
    const adapter = resolveAgent(options?.agent);
    return adapter
      .run({
        prompt,
        model: options?.model ?? store.modelFor(adapter.name),
        sessionId: store.sessionFor(primaryChatId(), adapter.name),
        mode: options?.mode,
        cwd,
      })
      .result();
  }

  return {
    async start() {
      // Long-polling: no requiere URL pública ni webhooks.
      await grammy.start({
        onStart: (me) =>
          console.log(`[telegram2agent] ${me.username} escuchando…`),
      });
    },
    async stop() {
      await grammy.stop();
    },
    async ask(prompt, options) {
      return execute(prompt, options ?? {});
    },
    run(prompt, options) {
      const adapter = resolveAgent(options?.agent);
      const chatId = options?.chatId ?? config.allow[0];
      if (typeof chatId !== "number") return undefined;

      const handle = adapter.run({
        prompt,
        model: options?.model ?? store.modelFor(adapter.name),
        mode: options?.mode,
        cwd,
      });
      const task = registry.create(prompt.slice(0, 80), chatId);
      task.bind(() => handle.cancel());

      task.onDone(async ({ result }) => {
        if (!result) return;
        await grammy.api.sendMessage(
          chatId,
          [
            `${task.status === "done" ? "✅" : "⚠️"} Tarea #${task.id} terminada`,
            "",
            sanitizeForTelegram(result.text.slice(0, 3000)) || "(sin salida)",
          ].join("\n"),
        );
      });

      void handle.result().then(
        (result) => task.complete(result),
        (error: Error) => task.fail(error),
      );
      return task;
    },
    async notify(text) {
      const chatId = config.allow[0];
      if (typeof chatId !== "number") return;
      await grammy.api.sendMessage(chatId, text);
    },
    registry,
    grammy,
  };
}
