import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InputFile, type Api } from "grammy";
import { extractFileRefs } from "../agents/spawn";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Extensiones con las que el fallback heurístico busca archivos mencionados
 * en la respuesta del agente.
 */
const KNOWN_EXTENSIONS =
  "png|jpe?g|gif|webp|svg|pdf|csv|xlsx?|zip|t(?:a)?r(?:\\.(?:gz|zst))?";

/** Token de ruta: segmentos de palabra (con ./ o / iniciales) terminando en extensión conocida. */
const PATH_TOKEN = new RegExp(
  `(?:\\.?/?[\\w@][\\w@.+-]*)(?:/[\\w@.+-]+)*\\.(?:${KNOWN_EXTENSIONS})`,
  "gi",
);

export interface IncomingAttachment {
  path: string;
  name: string;
}

/** Descarga una foto o documento entrante a un directorio temporal. */
export async function downloadIncoming(
  api: Api,
  fileId: string,
  fileName: string | undefined,
  chatKey: string,
): Promise<IncomingAttachment> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram no devolvió file_path");
  const url = `https://api.telegram.org/file/bot${api.token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Descarga fallida: ${response.status}`);

  const dir = path.join(os.tmpdir(), "telegram2agent", sanitize(chatKey));
  await mkdir(dir, { recursive: true });
  const name = sanitize(fileName ?? path.basename(file.file_path)) || "adjunto";
  const target = path.join(dir, `${Date.now()}-${name}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(target, buffer);
  return { path: target, name };
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Resuelve una ruta pedida por el usuario garantizando que viva dentro de root. */
export function resolveWithin(
  root: string,
  requested: string,
): string | undefined {
  const resolved = path.resolve(root, requested);
  const normalizedRoot = path.resolve(root);
  if (
    resolved !== normalizedRoot &&
    !resolved.startsWith(normalizedRoot + path.sep)
  ) {
    return undefined;
  }
  return resolved;
}

/**
 * Extrae los archivos que el agente entregó en su respuesta:
 * líneas `FILE:` (protocolo explícito, se confían tal cual) y,
 * como fallback heurístico, rutas existentes mencionadas en el texto
 * (absolutas, `./relativas` o relativas bare como `examples/foto.webp`,
 * con o sin backticks).
 */
export function collectOutboundFiles(text: string, cwd: string): string[] {
  const found = new Set<string>();

  for (const ref of extractFileRefs(text)) {
    const resolved = path.isAbsolute(ref) ? ref : resolveWithin(cwd, ref);
    if (resolved) found.add(resolved);
  }

  // Fallback: tokens con aspecto de ruta que existan en disco.
  for (const match of text.matchAll(PATH_TOKEN)) {
    const candidate = match[0];
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : resolveWithin(cwd, candidate);
    if (resolved && existsSync(resolved)) found.add(resolved);
  }

  return [...found].filter((file) => !file.includes("*"));
}

export async function sendFiles(
  api: Api,
  chatId: number,
  files: string[],
): Promise<void> {
  for (const file of files.slice(0, 5)) {
    try {
      const input = new InputFile(file);
      const asPhoto = isImage(file) && !isTooLarge(file);
      if (asPhoto) {
        await api.sendPhoto(chatId, input);
      } else {
        await api.sendDocument(chatId, input);
      }
      console.log(`[telegram2agent] enviado al chat ${chatId}: ${file}`);
    } catch (error) {
      console.error(`[telegram2agent] no se pudo enviar ${file}:`, error);
    }
  }
}

function isImage(file: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function isTooLarge(file: string): boolean {
  try {
    return statSync(file).size > MAX_PHOTO_BYTES;
  } catch {
    return false;
  }
}
