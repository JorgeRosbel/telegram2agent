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
