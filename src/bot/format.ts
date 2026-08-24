/**
 * Instrucciones de formato que se inyectan en cada run: Telegram (parse_mode
 * legacy Markdown) solo renderiza *bold*, _italic_, `código`, bloques ``` y
 * [links](url). Los encabezados, tablas y ** dobles rompen el renderizado.
 */
export const TELEGRAM_FORMAT_INSTRUCTION = [
  "",
  "Formato de respuesta OBLIGATORIO (el destino es un chat de Telegram):",
  "- Nada de encabezados con # ni ##; usa *negrita* para títulos.",
  '- Nada de tablas con |…|; usa listas "- clave: valor".',
  "- Nada de reglas horizontales ---.",
  "- Negrita con UN asterisco (*así*), no dos (**no así**).",
  "- Código y rutas entre backticks (`así`).",
  '- Listas con "- " y respuestas concisas.',
].join("\n");

const BOLD_DOUBLE = /\*\*(.+?)\*\*/g;

/** Convierte una fila de tabla "| a | b |" en "• a — b". */
function tableRowToBullet(line: string): string {
  const cells = line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0 && !/^:?-{2,}:?$/.test(cell));
  if (cells.length === 0) return "";
  if (cells.length === 1) return `- ${cells[0]}`;
  return `- ${cells[0]} — ${cells.slice(1).join(" · ")}`;
}

function isTableRow(line: string): boolean {
  return /^\s*\|.+\|\s*$/.test(line);
}

/**
 * Sanitiza la salida del agente para que Telegram la renderice sin errores:
 * negritas dobles → simples, encabezados → negrita, tablas → listas,
 * reglas horizontales fuera.
 */
export function sanitizeForTelegram(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    if (isTableRow(line)) {
      const bullet = tableRowToBullet(line);
      if (bullet) out.push(bullet);
      continue;
    }
    // Regla horizontal completa fuera.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;

    // Encabezado "## Título" → negrita "*Título*".
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    const converted =
      heading?.[1] !== undefined
        ? `*${heading[1].trim()}*`
        : line.replace(BOLD_DOUBLE, "*$1*");
    out.push(converted);
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Escapa texto para parse_mode HTML (seguro también dentro de atributos). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Añade el cierre ``` si hay un número impar de cercos (parciales en vivo). */
export function balanceFences(text: string): string {
  const fences = (text.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

const FENCED_BLOCK = /```[\w-]*\n?([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BOLD = /\*([^*\n]+)\*/g;

/**
 * Convierte la salida del agente (ya sanitizada) en HTML de Telegram:
 * bloques cercados → <pre>, `código` → <code>, *negrita* → <b> y
 * [texto](url) → <a>. Todo lo demás queda escapado y a salvo.
 * Con balanceFences, los parciales de streaming con un bloque abierto
 * se cierran antes de convertir.
 */
export function toTelegramHtml(
  text: string,
  options?: { balanceFences?: boolean },
): string {
  const sanitized = sanitizeForTelegram(text);
  const source = options?.balanceFences ? balanceFences(sanitized) : sanitized;
  const escaped = escapeHtml(source);

  // El código se aparta antes de convertir negritas/enlaces para que sus
  // caracteres no se toquen; luego se restauran los fragmentos.
  // (Marcador del Private Use Area: no colisiona con texto real.)
  const stash: string[] = [];
  const park = (html: string): string => {
    stash.push(html);
    return `\uE000${stash.length - 1}\uE001`;
  };

  let out = escaped.replace(FENCED_BLOCK, (_m, code: string) =>
    park(`<pre>${code.replace(/^\n+|\n+$/g, "")}</pre>`),
  );
  out = out.replace(INLINE_CODE, (_m, code: string) =>
    park(`<code>${code}</code>`),
  );
  out = out.replace(LINK, (_m, label: string, url: string) =>
    park(`<a href="${url}">${label}</a>`),
  );
  out = out.replace(BOLD, "<b>$1</b>");
  out = out.replace(
    /\uE000(\d+)\uE001/g,
    (_m, index: string) => stash[Number(index)] ?? "",
  );
  return out;
}
