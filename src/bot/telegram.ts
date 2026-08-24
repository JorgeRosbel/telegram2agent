import { Bot, type Context } from "grammy";
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
import {
  approvalKeyboard,
  agentsKeyboard,
  modelsKeyboard,
  modesKeyboard,
} from "./keyboards";
import { sanitizeForTelegram } from "./format";
import {
  collectOutboundFiles,
  downloadIncoming,
  resolveWithin,
  sendFiles,
} from "./media";
import { StreamEditor } from "./streaming";

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
}

const HELP = [
  "*telegram2agent* — tu agente CLI por Telegram",
  "",
  "• Escribe un mensaje → lo responde el agente activo",
  "• Envía una foto o documento → llega como adjunto al agente",
  "• Responde (reply) a un mensaje del bot → continúa esa sesión",
  "",
  "`/model` — elegir modelo (queda como default)",
  "`/agent` — cambiar entre Claude Code y OpenCode",
  "`/mode` — modo plan (solo lectura) o editar (aplica cambios)",
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
  bot.command("start", (ctx) => ctx.reply(HELP, { parse_mode: "Markdown" }));
  bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "Markdown" }));

  bot.command("model", async (ctx) => {
    const adapter = currentAdapter();
    const models = await adapter.listModels();
    if (models.length === 0) {
      await ctx.reply(
        `No hay modelos configurados para *${adapter.name}*. Añádelos en createBot({ opencode: { models: ['provider/model'] } }) o usa claude con sus alias nativos.`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    await ctx.reply(`Modelos de *${adapter.name}* (elige el default):`, {
      parse_mode: "Markdown",
      reply_markup: modelsKeyboard(models),
    });
  });

  bot.command("agent", (ctx) => {
    void ctx.reply("Agente activo:", {
      reply_markup: agentsKeyboard(store.agent),
    });
  });

  bot.command("mode", (ctx) => {
    void ctx.reply(`Modo de *${store.agent}*:`, {
      parse_mode: "Markdown",
      reply_markup: modesKeyboard(store.modeFor(store.agent, defaultMode)),
    });
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
    void ctx.reply(["*Tareas en curso*", ...lines].join("\n"), {
      parse_mode: "Markdown",
    });
  });

  bot.command("status", (ctx) => {
    const task = taskFromCommand(ctx, String(ctx.match ?? ""));
    if (!task) return;
    const minutes = Math.round(task.elapsedMs / 60000);
    void ctx.reply(
      `#${task.id} → *${task.status}* (${minutes} min)\n${truncate(task.description, 120)}`,
      {
        parse_mode: "Markdown",
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
      await ctx.reply("Uso: `/file <ruta>` (relativa al proyecto)", {
        parse_mode: "Markdown",
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
      `✅ Modelo por defecto de *${store.agent}*: \`${model}\``,
      {
        parse_mode: "Markdown",
      },
    );
  });

  bot.callbackQuery(/^agent:(\w+)$/, async (ctx) => {
    const agent = ctx.match[1] as AgentName;
    if (!(agent in adapters)) return;
    await store.setAgent(agent);
    await ctx.answerCallbackQuery({ text: `Agente activo: ${agent}` });
    await ctx.editMessageText(`✅ Agente activo: *${agent}*`, {
      parse_mode: "Markdown",
    });
  });

  bot.callbackQuery(/^mode:(plan|edit)$/, async (ctx) => {
    const mode = ctx.match[1] as AgentMode;
    if (!mode) return;
    await store.setMode(store.agent, mode);
    const label = mode === "plan" ? "📋 plan (solo lectura)" : "✏️ editar";
    await ctx.answerCallbackQuery({ text: `Modo: ${label}` });
    await ctx.editMessageText(`✅ Modo de *${store.agent}*: ${label}`, {
      parse_mode: "Markdown",
    });
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
    if (ctx.msg.text.startsWith("/")) return;
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
      void ctx.reply("Uso: `/status <id>` o `/cancel <id>`", {
        parse_mode: "Markdown",
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
    const editor = new StreamEditor(ctx.api, chatId);
    const label = attachmentHint ? `📎 ${attachmentHint} · ` : "";

    const progressMessageId = await editor.start(
      `${label}🤖 ${agent} (${mode === "plan" ? "📋 plan" : "✏️ edit"}) está trabajando…`,
    );

    // En plan no hay acciones sensibles que aprobar.
    const result = await executeRun(adapter, chatId, {
      prompt,
      files,
      sessionId: sessionId ?? store.sessionFor(chatId, agent),
      mode,
      onPermission:
        mode === "edit" && adapter.name === "claude"
          ? (request) => askApproval(ctx, request)
          : undefined,
      onText: (partial) => editor.update(partial),
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
      [sanitizeForTelegram(result.text) || "(sin respuesta)", "", footer].join(
        "\n",
      ),
    );

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
    },
  ): Promise<RunResult> {
    const handle = adapter.run({
      prompt: opts.prompt,
      model: store.modelFor(adapter.name),
      sessionId: opts.sessionId,
      mode: opts.mode,
      cwd,
      files: opts.files,
      onPermission: opts.onPermission,
      onText: opts.onText,
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
      [
        "🔐 *El agente pide permiso:*",
        `Herramienta: \`${request.tool}\``,
        request.summary ? `\`${escapeMarkdown(request.summary)}\`` : "",
        `\nExpira en ${Math.round(approvalTimeoutMs / 1000)}s.`,
      ]
        .filter(Boolean)
        .join("\n"),
      { parse_mode: "Markdown", reply_markup: approvalKeyboard(key) },
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

function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max - 1)}…`
    : text.replace(/\n/g, " ");
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]`])/g, "\\$1");
}

// Ruta base exportada para reuso en tests.
export const DEFAULT_DB_FILENAME = ".telegram2agent.json";
export function dbPathFor(cwd: string): string {
  return path.join(cwd, DEFAULT_DB_FILENAME);
}
