import { Bot, type Api, type Context } from "grammy";
import path from "node:path";
import type {
  AgentAdapter,
  AgentMode,
  AgentName,
  PermissionRequest,
  RunResult,
} from "../agents/types";
import type { ApprovalBridge } from "../tasks/approvals";
import type { StateStore } from "../state/store";
import type { TaskRegistry } from "../tasks/registry";
import { VERSION } from "../version";
import {
  approvalKeyboard,
  agentsKeyboard,
  effortsKeyboard,
  modelsKeyboard,
  modesKeyboard,
} from "./keyboards";
import { escapeHtml, toTelegramHtml } from "./format";
import {
  collectOutboundFiles,
  downloadIncoming,
  resolveWithin,
  sendFiles,
} from "./media";
import { StreamEditor } from "./streaming";
import { parseShellCommand, runShell, type ShellResult } from "./shell";

export interface TelegramLayerOptions {
  token: string;
  allow: Array<number | string>;
  cwd: string;
  adapters: Record<AgentName, AgentAdapter>;
  store: StateStore;
  registry: TaskRegistry;
  approvals: ApprovalBridge;
  approvalTimeoutMs?: number;
  defaultMode?: AgentMode;
  footer?: (result: RunResult) => string;
  /** Mensajes "!cmd" se ejecutan en la terminal. Default: true. */
  shellEnabled?: boolean;
  /** Timeout de los comandos "!cmd". Default: 300_000 (5 min). */
  shellTimeoutMs?: number;
  /** Thinking del agente visible en el chat. Default: true. */
  thinking?: boolean;
  /** Timeout máximo por ejecución del agente. Default: 30 min. */
  taskTimeoutMs?: number;
  /** Auto mode real: no se piden aprobaciones por Telegram. Default: false. */
  autoMode?: boolean;
}

const HELP = [
  "*telegram2agent* — tu agente CLI por Telegram",
  "",
  "• Escribe un mensaje → lo responde el agente activo",
  "• `!comando` → lo ejecuta en la terminal del proyecto (ej. `!pnpm test`)",
  "• Envía una foto o documento → llega como adjunto al agente",
  "• Responde (reply) a un mensaje del bot → continúa esa sesión",
  "• Si el agente razona, su thinking llega en un mensaje expandible 🧠",
  "",
  "`/model` — elegir modelo (queda como default)",
  "`/agent` — cambiar entre Claude Code y OpenCode",
  "`/mode` — modo plan (solo lectura) o editar (aplica cambios)",
  "`/effort` — reasoning effort del agente (low…max)",
  "`/config` — ver la configuración (sin credenciales)",
  "`/tasks` — tareas en segundo plano",
  "`/status <id>` — estado de una tarea",
  "`/cancel <id>` — cancelar una tarea",
  "`/file <ruta>` — enviar un archivo del proyecto (solo dentro de cwd)",
].join("\n");

export function createTelegramBot(options: TelegramLayerOptions): Bot {
  const { token, allow, cwd, adapters, store, registry, approvals } = options;
  const bot = new Bot(token);
  const sessionByMessage = new Map<
    number,
    { sessionId: string; agent: AgentName }
  >();
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
  const defaultMode: AgentMode = options.defaultMode ?? "edit";
  const autoMode = options.autoMode ?? false;
  let botUserId: number | undefined;

  // ── Seguridad: allowlist estricta antes de cualquier handler ────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const username = ctx.from?.username;
    const allowed =
      (typeof chatId === "number" && allow.includes(chatId)) ||
      (username !== undefined && allow.includes(`@${username}`));
    if (!allowed) {
      if (chatId !== undefined) {
        console.warn(`[telegram2agent] chat no permitido ignorado: ${chatId}`);
      }
      return;
    }
    return next();
  });

  bot.api
    .getMe()
    .then((me) => {
      botUserId = me.id;
    })
    .catch(() => undefined);

  // ── Comandos ─────────────────────────────────────────────────────────────
  const replyHtml = (text: string) => toTelegramHtml(text);
  bot.command("start", (ctx) =>
    ctx.reply(replyHtml(HELP), { parse_mode: "HTML" }),
  );
  bot.command("help", (ctx) =>
    ctx.reply(replyHtml(HELP), { parse_mode: "HTML" }),
  );

  bot.command("model", async (ctx) => {
    const adapter = currentAdapter();
    const models = await adapter.listModels();
    if (models.length === 0) {
      await ctx.reply(
        replyHtml(
          `No hay modelos configurados para *${adapter.name}*. Añádelos en createBot({ opencode: { models: ['provider/model'] } }) o usa claude con sus alias nativos.`,
        ),
        { parse_mode: "HTML" },
      );
      return;
    }
    await ctx.reply(
      replyHtml(`Modelos de *${adapter.name}* (elige el default):`),
      {
        parse_mode: "HTML",
        reply_markup: modelsKeyboard(models),
      },
    );
  });

  bot.command("agent", (ctx) => {
    void ctx.reply("Agente activo:", {
      reply_markup: agentsKeyboard(store.agent),
    });
  });

  bot.command("mode", (ctx) => {
    void ctx.reply(replyHtml(`Modo de *${store.agent}*:`), {
      parse_mode: "HTML",
      reply_markup: modesKeyboard(store.modeFor(store.agent, defaultMode)),
    });
  });

  bot.command("effort", (ctx) => {
    const agent = store.agent;
    const effort = store.effortFor(agent);
    void ctx.reply(
      replyHtml(
        `Reasoning effort de *${agent}*: *${effort ?? "default"}*\nElegir nivel (persistente por agente):`,
      ),
      {
        parse_mode: "HTML",
        reply_markup: effortsKeyboard(agent, effort),
      },
    );
  });

  bot.command("config", (ctx) => {
    const agent = store.agent;
    const shellTimeoutS = Math.round(
      (options.shellTimeoutMs ?? 300_000) / 1000,
    );
    const lines = [
      "*Configuración del bot*",
      `- agente activo: *${agent}*`,
      `- modelo ${agent}: \`${store.modelFor(agent) ?? "(default)"}\``,
      `- modo ${agent}: *${store.modeFor(agent, defaultMode)}*`,
      `- effort ${agent}: *${store.effortFor(agent) ?? "default"}*`,
      `- thinking: *${options.thinking !== false ? "activado 🧠" : "desactivado"}*`,
      `- shell: *${options.shellEnabled !== false ? "activado" : "desactivado"}* (timeout ${shellTimeoutS}s)`,
      `- auto mode: *${autoMode ? "activado ⚡ (sin aprobaciones)" : "desactivado"}*`,
      `- aprobaciones: ${Math.round(approvalTimeoutMs / 1000)}s`,
      `- timeout tarea: ${Math.round((options.taskTimeoutMs ?? 1_800_000) / 60000)} min`,
      `- cwd: \`${cwd}\``,
      `- versión: \`${VERSION}\``,
      `- token: \`*******\``,
    ];
    void ctx.reply(replyHtml(lines.join("\n")), { parse_mode: "HTML" });
  });

  bot.command("tasks", (ctx) => {
    const running = registry.running();
    if (running.length === 0) {
      void ctx.reply("No hay tareas en segundo plano. ✨");
      return;
    }
    const lines = running.map(
      (task) =>
        `#${task.id} · ${Math.round(task.elapsedMs / 1000)}s · ${truncate(task.description, 60)}`,
    );
    void ctx.reply(replyHtml(["*Tareas en curso*", ...lines].join("\n")), {
      parse_mode: "HTML",
    });
  });

  bot.command("status", (ctx) => {
    const task = taskFromCommand(ctx, String(ctx.match ?? ""));
    if (!task) return;
    const minutes = Math.round(task.elapsedMs / 60000);
    void ctx.reply(
      replyHtml(
        `#${task.id} → *${task.status}* (${minutes} min)\n${truncate(task.description, 120)}`,
      ),
      {
        parse_mode: "HTML",
      },
    );
  });

  bot.command("cancel", async (ctx) => {
    const task = taskFromCommand(ctx, String(ctx.match ?? ""));
    if (!task) return;
    await task.cancel();
    await ctx.reply(`Tarea #${task.id} cancelada. 🛑`);
  });

  bot.command("file", async (ctx) => {
    const requested = ctx.match?.trim();
    if (!requested) {
      await ctx.reply(replyHtml("Uso: `/file <ruta>` (relativa al proyecto)"), {
        parse_mode: "HTML",
      });
      return;
    }
    const resolved = resolveWithin(cwd, requested);
    if (!resolved) {
      await ctx.reply("⚠️ Esa ruta está fuera del directorio del proyecto.");
      return;
    }
    await sendFiles(ctx.api, chatIdOf(ctx), [resolved]);
  });

  // ── Callback queries (teclados inline y aprobaciones) ────────────────────
  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    const model = ctx.match[1];
    if (!model) return;
    await store.setModel(store.agent, model);
    await ctx.answerCallbackQuery({ text: `Modelo por defecto: ${model}` });
    await ctx.editMessageText(
      replyHtml(`✅ Modelo por defecto de *${store.agent}*: \`${model}\``),
      {
        parse_mode: "HTML",
      },
    );
  });

  bot.callbackQuery(/^agent:(\w+)$/, async (ctx) => {
    const agent = ctx.match[1] as AgentName;
    if (!(agent in adapters)) return;
    await store.setAgent(agent);
    await ctx.answerCallbackQuery({ text: `Agente activo: ${agent}` });
    await ctx.editMessageText(replyHtml(`✅ Agente activo: *${agent}*`), {
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/^mode:(plan|edit)$/, async (ctx) => {
    const mode = ctx.match[1] as AgentMode;
    if (!mode) return;
    await store.setMode(store.agent, mode);
    const label = mode === "plan" ? "📋 plan (solo lectura)" : "✏️ editar";
    await ctx.answerCallbackQuery({ text: `Modo: ${label}` });
    await ctx.editMessageText(
      replyHtml(`✅ Modo de *${store.agent}*: ${label}`),
      {
        parse_mode: "HTML",
      },
    );
  });

  bot.callbackQuery(/^effort:(.+)$/, async (ctx) => {
    const value = ctx.match[1];
    const effort = value === "default" ? undefined : value;
    await store.setEffort(store.agent, effort);
    await ctx.answerCallbackQuery({ text: `Effort: ${effort ?? "default"}` });
    await ctx.editMessageText(
      replyHtml(`✅ Effort de *${store.agent}*: *${effort ?? "default"}*`),
      {
        parse_mode: "HTML",
      },
    );
  });

  bot.callbackQuery(/^perm:(.+):(0|1)$/, async (ctx) => {
    const key = ctx.match[1];
    const allowed = ctx.match[2] === "1";
    if (!key || !approvals.answer(key, allowed)) {
      await ctx.answerCallbackQuery({ text: "Esta solicitud ya expiró." });
      return;
    }
    await ctx.answerCallbackQuery({
      text: allowed ? "Aprobado ✅" : "Denegado ❌",
    });
    await ctx.editMessageText(
      allowed ? "✅ Acción aprobada." : "❌ Acción denegada.",
    );
  });

  // ── Fotos y documentos entrantes ────────────────────────────────────────
  bot.on(["message:photo", "message:document"], (ctx) => {
    void handleIncomingMedia(ctx);
  });

  // ── Texto libre → pregunta al agente ────────────────────────────────────
  bot.on("message:text", (ctx) => {
    const text = ctx.msg.text;
    if (text.startsWith("/")) return;
    if (options.shellEnabled !== false) {
      const command = parseShellCommand(text);
      if (command !== undefined) {
        void handleShellCommand(ctx, command);
        return;
      }
    }
    void handlePrompt(ctx);
  });

  function currentAdapter(): AgentAdapter {
    return adapters[store.agent];
  }

  function chatIdOf(ctx: Context): number {
    return ctx.chat?.id ?? 0;
  }

  function taskFromCommand(ctx: Context, match: string) {
    const id = Number.parseInt(match.trim(), 10);
    if (Number.isNaN(id)) {
      void ctx.reply(replyHtml("Uso: `/status <id>` o `/cancel <id>`"), {
        parse_mode: "HTML",
      });
      return undefined;
    }
    const task = registry.get(id);
    if (!task) {
      void ctx.reply(`No encontré la tarea #${id}.`);
      return undefined;
    }
    return task;
  }

  async function handleIncomingMedia(ctx: Context): Promise<void> {
    const msg = ctx.msg;
    if (!msg) return;
    const prompt = msg.caption ?? "Analiza este archivo adjunto.";
    try {
      let fileId: string | undefined;
      let fileName: string | undefined;

      if ("photo" in msg && msg.photo) {
        fileId = msg.photo.at(-1)?.file_id;
      }
      if ("document" in msg && msg.document) {
        fileId = msg.document.file_id;
        fileName = msg.document.file_name;
      }
      if (!fileId) return;

      const attachment = await downloadIncoming(
        ctx.api,
        fileId,
        fileName,
        String(chatIdOf(ctx)),
      );
      await runForeground(ctx, prompt, [attachment.path], attachment.name);
    } catch (error) {
      console.error("[telegram2agent] error descargando adjunto:", error);
      await ctx.reply("⚠️ No pude descargar el adjunto.");
    }
  }

  async function handlePrompt(ctx: Context): Promise<void> {
    const replyTo = ctx.msg?.reply_to_message;
    const isReplyToBot =
      replyTo?.from?.id !== undefined && replyTo.from.id === botUserId;

    let sessionId: string | undefined;
    if (isReplyToBot && replyTo?.message_id !== undefined) {
      sessionId = sessionByMessage.get(replyTo.message_id)?.sessionId;
    }

    await runForeground(ctx, ctx.msg?.text ?? "", [], undefined, sessionId);
  }

  /** Ejecuta un comando "!cmd" en la terminal del proyecto y responde con su salida. */
  async function handleShellCommand(
    ctx: Context,
    command: string,
  ): Promise<void> {
    const chatId = chatIdOf(ctx);
    const progress = await ctx.reply(`⚙️ Ejecutando: ${command}`);

    const handle = runShell(command, {
      cwd,
      timeoutMs: options.shellTimeoutMs,
    });
    const task = registry.create(`$ ${command}`.slice(0, 80), chatId);
    task.bind(async () => handle.cancel());

    const result = await handle.result();
    task.complete({
      ok: !result.killed && result.exitCode === 0,
      text: [result.stdout, result.stderr].filter(Boolean).join("\n"),
      durationMs: result.durationMs,
    });

    await ctx.api.editMessageText(
      chatId,
      progress.message_id,
      shellReplyHtml(result),
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    );
  }

  /** Ejecuta una pregunta interactiva con streaming y entrega de archivos. */
  async function runForeground(
    ctx: Context,
    prompt: string,
    files: string[],
    attachmentHint: string | undefined,
    sessionId?: string,
  ): Promise<void> {
    const chatId = chatIdOf(ctx);
    const agent = store.agent;
    const adapter = adapters[agent];
    const mode = store.modeFor(agent, defaultMode);
    const editor = new StreamEditor(ctx.api, chatId, "HTML");
    const label = attachmentHint ? `📎 ${attachmentHint} · ` : "";

    const modeLabel =
      mode === "plan" ? "📋 plan" : autoMode ? "⚡ auto" : "✏️ edit";
    const progressMessageId = await editor.start(
      `${label}🤖 ${agent} (${modeLabel}) está trabajando…`,
    );

    // En plan no hay acciones sensibles que aprobar.
    const result = await executeRun(adapter, chatId, {
      prompt,
      files,
      sessionId: sessionId ?? store.sessionFor(chatId, agent),
      mode,
      onPermission:
        mode === "edit" && adapter.name === "claude" && !autoMode
          ? (request) => askApproval(ctx, request)
          : undefined,
      onText: (partial) =>
        editor.update(toTelegramHtml(partial, { balanceFences: true })),
      onUsageLimitWait: (info) => {
        if (info.attempt !== 1) return;
        const minutes = Math.round(info.retryInMs / 60000);
        void ctx.api.sendMessage(
          chatId,
          replyHtml(
            `⏳ *${agent}* alcanzó el límite de uso de tu plan actual. ` +
              `El bot sigue funcionando — va a reintentar cada ${minutes} min ` +
              "hasta que se restablezca, sin que tengas que hacer nada.",
          ),
          { parse_mode: "HTML" },
        );
      },
    });

    if (result.sessionId) {
      await store.setSession(chatId, agent, result.sessionId);
      sessionByMessage.set(progressMessageId, {
        sessionId: result.sessionId,
        agent,
      });
      // El mensaje final también sirve de ancla para continuar la sesión.
      sessionByMessage.set(progressMessageId + 1, {
        sessionId: result.sessionId,
        agent,
      });
    }

    const footer = options.footer?.(result) ?? defaultFooter(result);
    await editor.finish(
      [
        toTelegramHtml(result.text) || "(sin respuesta)",
        "",
        escapeHtml(footer),
      ].join("\n"),
    );

    // El thinking va en mensaje aparte, después de la respuesta: así su id
    // cae en progressMessageId+1, que ya es ancla de sesión para replies.
    //
    // `options.thinking` solo controla el flag --thinking de OpenCode (sin
    // él, el CLI ni emite el bloque). Claude no tiene un flag equivalente:
    // emite thinking siempre que el modelo razona, así que hay que filtrar
    // acá también — si no, `thinking: false` no tiene ningún efecto en Claude.
    if (result.thinking && options.thinking !== false) {
      await sendThinking(ctx.api, chatId, result.thinking);
    }

    const outbound = collectOutboundFiles(result.text, cwd);
    if (outbound.length > 0) await sendFiles(ctx.api, chatId, outbound);
  }

  /** Lanza el adapter con permisos puente y devuelve el resultado. */
  function executeRun(
    adapter: AgentAdapter,
    chatId: number,
    opts: {
      prompt: string;
      files: string[];
      sessionId?: string;
      mode?: AgentMode;
      onPermission?: (r: PermissionRequest) => Promise<boolean>;
      onText?: (partial: string) => void;
      onUsageLimitWait?: (info: { attempt: number; retryInMs: number }) => void;
    },
  ): Promise<RunResult> {
    const handle = adapter.run({
      prompt: opts.prompt,
      model: store.modelFor(adapter.name),
      effort: store.effortFor(adapter.name),
      sessionId: opts.sessionId,
      mode: opts.mode,
      cwd,
      files: opts.files,
      onPermission: opts.onPermission,
      onText: opts.onText,
      onUsageLimitWait: opts.onUsageLimitWait,
    });

    const task = registry.create(opts.prompt.slice(0, 80), chatId);
    task.bind(() => handle.cancel());
    void handle.result().then(
      (result) => task.complete(result),
      (error: Error) => task.fail(error),
    );

    return handle.result();
  }

  async function askApproval(
    ctx: Context,
    request: PermissionRequest,
  ): Promise<boolean> {
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const promise = approvals.create(key, request);
    await ctx.api.sendMessage(
      chatIdOf(ctx),
      replyHtml(
        [
          "🔐 *El agente pide permiso:*",
          `Herramienta: \`${request.tool}\``,
          request.summary ? `\`${request.summary}\`` : "",
          `\nExpira en ${Math.round(approvalTimeoutMs / 1000)}s.`,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
      { parse_mode: "HTML", reply_markup: approvalKeyboard(key) },
    );
    return promise;
  }

  return bot;
}

function defaultFooter(result: RunResult): string {
  const parts: string[] = [];
  if (result.costUsd !== undefined)
    parts.push(`💵 $${result.costUsd.toFixed(4)}`);
  if (result.durationMs !== undefined)
    parts.push(`⏱ ${(result.durationMs / 1000).toFixed(1)}s`);
  return parts.length > 0 ? parts.join(" · ") : "";
}

const SHELL_OUTPUT_LIMIT = 3_500;

const THINKING_LIMIT = 3_800;

/** Envía el razonamiento del agente como cita expandible (colapsada por defecto). */
async function sendThinking(
  api: Api,
  chatId: number,
  thinking: string,
): Promise<void> {
  const truncated = thinking.length > THINKING_LIMIT;
  const body = escapeHtml(thinking.slice(0, THINKING_LIMIT));
  await api.sendMessage(
    chatId,
    `🧠 <blockquote expandable>${body}${truncated ? "\n…" : ""}</blockquote>`,
    {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
  );
}

function shellStatusLine(result: ShellResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  if (result.killed) {
    return `🛑 terminado por ${result.signal ?? "cancelación"} · ${seconds}s`;
  }
  if (result.exitCode === 0) return `✅ exit 0 · ${seconds}s`;
  const reason =
    result.exitCode !== null
      ? `exit ${result.exitCode}`
      : `señal ${result.signal ?? "?"}`;
  return `❌ ${reason} · ${seconds}s`;
}

function shellReplyHtml(result: ShellResult): string {
  const header = `$ ${result.command}\n${shellStatusLine(result)}`;
  const output = [result.stdout, result.stderr]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  const suffix =
    result.outputTruncated || output.length > SHELL_OUTPUT_LIMIT ? "\n…" : "";
  const body =
    output.length > 0 ? output.slice(0, SHELL_OUTPUT_LIMIT) : "(sin salida)";
  return `${escapeHtml(header)}\n<pre>${escapeHtml(body)}${suffix}</pre>`;
}

function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max - 1)}…`
    : text.replace(/\n/g, " ");
}

// Ruta base exportada para reuso en tests.
export const DEFAULT_DB_FILENAME = ".telegram2agent.json";
export function dbPathFor(cwd: string): string {
  return path.join(cwd, DEFAULT_DB_FILENAME);
}
