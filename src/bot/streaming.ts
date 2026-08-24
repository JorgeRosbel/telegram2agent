import type { Api } from "grammy";

const TELEGRAM_LIMIT = 4096;
const EDIT_INTERVAL_MS = 1500;

type ParseMode = "HTML";

/**
 * Edita un mensaje de Telegram con el texto parcial del agente, respetando
 * los rate limits (máximo ~1 edición por intervalo). Al terminar fija el
 * texto final completo, dividiéndolo en varios mensajes si excede el límite.
 * Con parseMode, los edits van con ese formato y, si Telegram rechaza el
 * HTML (tags sin cerrar en parciales), reintenta en texto plano.
 */
export class StreamEditor {
  private messageId?: number;
  private lastEditAt = 0;
  private pendingText = "";
  private dirty = false;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly parseMode?: ParseMode,
  ) {}

  /** Crea el mensaje de progreso y devuelve su id (ancla para sesiones por reply). */
  async start(initialText: string): Promise<number> {
    const message = await this.api.sendMessage(this.chatId, initialText);
    this.messageId = message.message_id;
    return message.message_id;
  }

  /** Recibe texto parcial; programa la próxima edición disponible. */
  update(partialText: string): void {
    if (!this.messageId) return;
    this.pendingText = truncate(partialText);
    if (this.dirty) return;
    const elapsed = Date.now() - this.lastEditAt;
    if (elapsed < EDIT_INTERVAL_MS) {
      this.dirty = true;
      setTimeout(() => {
        this.dirty = false;
        void this.flush();
      }, EDIT_INTERVAL_MS - elapsed);
      return;
    }
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.messageId) return;
    this.lastEditAt = Date.now();
    await safeEdit(
      this.api,
      this.chatId,
      this.messageId,
      this.pendingText,
      this.parseMode,
    );
  }

  /** Fija el texto final; si no cabe en un mensaje, lo divide. */
  async finish(finalText: string): Promise<void> {
    if (!this.messageId) return;
    const chunks =
      this.parseMode === "HTML"
        ? chunkHtmlMessage(finalText)
        : chunkMessage(finalText);
    const [first, ...rest] = chunks;
    if (first !== undefined) {
      await safeEdit(
        this.api,
        this.chatId,
        this.messageId,
        first,
        this.parseMode,
      );
    }
    for (const chunk of rest) {
      await sendWithFallback(this.api, this.chatId, chunk, this.parseMode);
    }
  }
}

function truncate(text: string): string {
  return text.length > TELEGRAM_LIMIT
    ? `${text.slice(0, TELEGRAM_LIMIT - 1)}…`
    : text;
}

function chunkMessage(text: string): string[] {
  if (text.length === 0) return ["(sin respuesta)"];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_LIMIT) {
    let cut = rest.lastIndexOf("\n", TELEGRAM_LIMIT - 1);
    if (cut < TELEGRAM_LIMIT / 2) cut = TELEGRAM_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  return chunks;
}

/**
 * Divide HTML respetando el límite y reabriendo/cerrando <pre> cuando el
 * corte cae dentro de un bloque de código (los cercos sí cruzan líneas).
 */
function chunkHtmlMessage(text: string): string[] {
  let open = false;
  return chunkMessage(text).map((chunk, index) => {
    let piece = index > 0 && open ? `<pre>${chunk}` : chunk;
    const delta =
      (piece.match(/<pre>/g)?.length ?? 0) -
      (piece.match(/<\/pre>/g)?.length ?? 0);
    open = delta > 0;
    if (open) piece = `${piece}</pre>`;
    return piece;
  });
}

function isParseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /can't parse entities|unsupported start tag|unclosed/i.test(error.message)
  );
}

async function sendWithFallback(
  api: Api,
  chatId: number,
  text: string,
  parseMode?: ParseMode,
): Promise<void> {
  try {
    await api.sendMessage(
      chatId,
      text,
      parseMode ? { parse_mode: parseMode } : undefined,
    );
  } catch (error) {
    if (parseMode && isParseError(error)) {
      await api.sendMessage(chatId, text);
      return;
    }
    throw error;
  }
}

async function safeEdit(
  api: Api,
  chatId: number,
  messageId: number,
  text: string,
  parseMode?: ParseMode,
): Promise<void> {
  try {
    await api.editMessageText(
      chatId,
      messageId,
      text || "…",
      parseMode ? { parse_mode: parseMode } : undefined,
    );
    return;
  } catch (error) {
    // HTML inválido (parcial con tags sin cerrar) → reintento en plano.
    if (parseMode && isParseError(error)) {
      try {
        await api.editMessageText(chatId, messageId, text || "…");
        return;
      } catch (retryError) {
        logEditFailure(retryError);
        return;
      }
    }
    logEditFailure(error);
  }
}

function logEditFailure(error: unknown): void {
  // "message is not modified" y rate limits se ignoran.
  if (
    !(error instanceof Error) ||
    !/not modified|too many/i.test(error.message)
  ) {
    console.error("[telegram2agent] editMessageText falló:", error);
  }
}
