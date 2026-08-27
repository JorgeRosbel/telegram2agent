import path from "node:path";
import type { Bot } from "grammy";
import {
  ClaudeAdapter,
  type ClaudeAdapterConfig,
  type ClaudeEffort,
  type ClaudeModel,
} from "./agents/claude";
import {
  OpencodeAdapter,
  type OpencodeAdapterConfig,
  type OpenCodeEffort,
} from "./agents/opencode";
import type { OpenCodeModel } from "./agents/opencode-models.generated";
import type {
  AgentAdapter,
  AgentMode,
  AgentName,
  RunOptions,
  RunResult,
} from "./agents/types";
import { createTelegramBot } from "./bot/telegram";
import { escapeHtml, toTelegramHtml } from "./bot/format";
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
export type {
  ClaudeModel,
  KnownClaudeModel,
  ClaudeEffort,
  KnownClaudeEffort,
} from "./agents/claude";
export type {
  OpenCodeModel,
  KnownOpenCodeModel,
} from "./agents/opencode-models.generated";
export type { OpenCodeEffort, KnownOpenCodeEffort } from "./agents/opencode";
export type { Task, TaskStatus } from "./tasks/registry";

/** Modelo de cualquier agente: autocomplete + cualquier string válido. */
export type AnyModel = ClaudeModel | OpenCodeModel;
/** Reasoning effort de cualquier agente: autocomplete + cualquier string válido. */
export type AnyEffort = ClaudeEffort | OpenCodeEffort;

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
    /**
     * Reasoning effort inicial, aplicado a ambos agentes (--effort en
     * Claude, --variant en OpenCode) — cada uno lo interpreta con sus
     * propios niveles válidos. Autocomplete con los niveles conocidos;
     * acepta cualquier string.
     */
    effort?: AnyEffort;
  };
  /** Timeout para aprobar acciones sensibles desde Telegram. Default: 120s. */
  approvalTimeoutMs?: number;
  /** Timeout máximo por ejecución del agente. Default: 30 min. */
  taskTimeoutMs?: number;
  /** Mensajes "!cmd" se ejecutan en la terminal del proyecto. Default: true. */
  shellEnabled?: boolean;
  /** Timeout de los comandos "!cmd". Default: 300_000 (5 min). */
  shellTimeoutMs?: number;
  /** Mostrar el razonamiento (thinking) del agente en el chat. Default: true. */
  thinking?: boolean;
  /**
   * Auto mode real: el agente ejecuta sin pedir aprobación por Telegram.
   * Claude corre con `--permission-mode bypassPermissions` (salta todos los
   * permisos, no solo ediciones); OpenCode corre con `autoApprove: true`
   * (`--auto`). Ambos se pueden sobreescribir por agente en `claude`/`opencode`.
   * Default: false.
   */
  autoMode?: boolean;
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
  /**
   * Como `run()`, pero devuelve una promesa que resuelve con el `RunResult`
   * (o rechaza si la tarea falla/se cancela) — pensado para encadenar pasos
   * con `await` en orden, cada uno continuando la sesión del anterior:
   *
   *   await bot.runStep('paso 1');
   *   await bot.runStep('paso 2'); // misma sesión que el paso 1
   *
   * Usa la misma configuración (agente, modelo, sesión, autoMode…) que
   * `run()`; el chat sigue recibiendo la notificación automática de cada
   * paso, esto solo añade el punto de espera para encadenarlos.
   */
  runStep(prompt: string, options?: RunTaskOptions): Promise<RunResult>;
  /**
   * Corta la continuidad: olvida la sesión guardada, de modo que el siguiente
   * `ask`/`run`/`runStep` arranque una conversación nueva en vez de reanudar
   * la anterior con `--resume`.
   *
   * Encadenar decenas de trabajos independientes en una sola sesión la hace
   * crecer sin techo (cada paso reanuda todo el historial previo), así que
   * conviene resetear entre unidades de trabajo que no comparten contexto:
   *
   *   for (const issue of issues) {
   *     await bot.resetSession();       // arranca limpio
   *     await bot.runStep('analiza…');  // estos tres sí comparten sesión
   *     await bot.runStep('implementa…');
   *     await bot.runStep('verifica…');
   *   }
   *
   * Los modelos/efforts persistidos no se tocan: solo se olvida la sesión.
   */
  resetSession(options?: {
    agent?: AgentName;
    chatId?: number | string;
  }): Promise<void>;
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
  /** Autocomplete con los niveles conocidos del agente; acepta cualquier string. */
  effort?: AnyEffort;
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

  const claude = new ClaudeAdapter({
    cwd,
    ...config.claude,
    permissionMode:
      config.claude?.permissionMode ??
      (config.autoMode ? "bypassPermissions" : undefined),
  });
  const opencode = new OpencodeAdapter({
    cwd,
    thinking: config.thinking,
    ...config.opencode,
    autoApprove: config.opencode?.autoApprove ?? config.autoMode,
  });
  const adapters: Record<AgentName, AgentAdapter> = { claude, opencode };

  const store = new StateStore(dbPath, {
    agent: config.defaults?.agent,
    models: config.defaults?.model,
    modes: config.defaults?.mode
      ? { [config.defaults.agent ?? "claude"]: config.defaults.mode }
      : {},
    // A diferencia de `model` (namespaces distintos por agente), un mismo
    // effort inicial tiene sentido para los dos — se aplica a ambos, no
    // solo al agente por defecto.
    efforts: config.defaults?.effort
      ? { claude: config.defaults.effort, opencode: config.defaults.effort }
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
    thinking: config.thinking,
    taskTimeoutMs: config.taskTimeoutMs,
    autoMode: config.autoMode,
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
    const chatId = primaryChatId();
    const result = await adapter
      .run({
        prompt,
        model: options?.model ?? store.modelFor(adapter.name),
        effort: options?.effort ?? store.effortFor(adapter.name),
        sessionId: store.sessionFor(chatId, adapter.name),
        mode: options?.mode,
        cwd,
        onUsageLimitWait: (info) => notifyUsageLimitWait(chatId, info),
      })
      .result();
    if (result.sessionId)
      await store.setSession(chatId, adapter.name, result.sessionId);
    return result;
  }

  /** Avisa al chat que un run se quedó esperando el reset del límite de uso. */
  function notifyUsageLimitWait(
    chatId: number | string,
    info: { attempt: number; retryInMs: number; resetsAt?: string },
  ): void {
    if (info.attempt !== 1) return;
    const minutes = Math.round(info.retryInMs / 60000);
    const when = info.resetsAt ? ` Se restablece ${info.resetsAt}.` : "";
    void grammy.api.sendMessage(
      chatId,
      toTelegramHtml(
        `⏳ Límite de uso del plan actual alcanzado.${when} La tarea queda ` +
          `dormida y reintenta cada ${minutes} min hasta que vuelva, sin que ` +
          "tengas que hacer nada.",
      ),
      { parse_mode: "HTML" },
    );
  }

  /** Lanza el adapter en segundo plano, ligado a la sesión y notificaciones del chat. */
  function launchTask(
    prompt: string,
    options: RunTaskOptions | undefined,
  ): Task | undefined {
    const adapter = resolveAgent(options?.agent);
    const chatId = options?.chatId ?? config.allow[0];
    if (typeof chatId !== "number") return undefined;

    const task = registry.create(prompt.slice(0, 80), chatId);
    const handle = adapter.run({
      prompt,
      model: options?.model ?? store.modelFor(adapter.name),
      effort: options?.effort ?? store.effortFor(adapter.name),
      sessionId: store.sessionFor(chatId, adapter.name),
      mode: options?.mode,
      cwd,
      onUsageLimitWait: (info) => {
        // El plazo de la tarea no debe consumirse mientras dormimos
        // esperando a que el plan se restablezca.
        task.pauseTimeout();
        notifyUsageLimitWait(chatId, info);
      },
      onUsageLimitResume: () => task.resumeTimeout(),
    });
    task.bind(() => handle.cancel());

    task.onDone(async ({ result }) => {
      if (!result) return;
      if (result.sessionId) {
        await store.setSession(chatId, adapter.name, result.sessionId);
      }
      const header = `${task.status === "done" ? "✅" : "⚠️"} Tarea #${task.id} terminada`;
      await grammy.api.sendMessage(
        chatId,
        [
          escapeHtml(header),
          "",
          toTelegramHtml(result.text.slice(0, 3000)) || "(sin salida)",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    });

    void handle.result().then(
      (result) => task.complete(result),
      (error: Error) => task.fail(error),
    );
    return task;
  }

  /** `runStep`: envuelve `launchTask` en una promesa para poder encadenar con await. */
  function runStep(
    prompt: string,
    options?: RunTaskOptions,
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const task = launchTask(prompt, options);
      if (!task) {
        reject(
          new Error(
            "runStep: chatId inválido (pasa un chatId numérico permitido en `allow`).",
          ),
        );
        return;
      }
      task.onDone(({ result, error }) => {
        if (error) reject(error);
        else if (result) resolve(result);
        else
          reject(
            new Error(`runStep: la tarea #${task.id} terminó sin resultado.`),
          );
      });
    });
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
    run: launchTask,
    runStep,
    async resetSession(options) {
      const chatId = options?.chatId ?? config.allow[0];
      if (chatId === undefined) return;
      await store.clearSession(chatId, resolveAgent(options?.agent).name);
    },
    async notify(text) {
      const chatId = config.allow[0];
      if (typeof chatId !== "number") return;
      await grammy.api.sendMessage(chatId, toTelegramHtml(text), {
        parse_mode: "HTML",
      });
    },
    registry,
    grammy,
  };
}
