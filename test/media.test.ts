import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { collectOutboundFiles, resolveWithin } from "@/bot/media";

describe("resolveWithin", () => {
  const root = path.join(os.tmpdir(), "t2a-root");

  it("resuelve rutas relativas dentro del root", () => {
    expect(resolveWithin(root, "dist/grafica.png")).toBe(
      path.join(root, "dist", "grafica.png"),
    );
  });

  it("acepta rutas absolutas que viven dentro del root", () => {
    const inner = path.join(root, "a.png");
    expect(resolveWithin(root, inner)).toBe(inner);
  });

  it("rechaza traversal con .. fuera del proyecto", () => {
    expect(resolveWithin(root, "../secreto.env")).toBeUndefined();
    expect(resolveWithin(root, "sub/../../../etc/passwd")).toBeUndefined();
  });

  it("rechaza rutas absolutas externas", () => {
    expect(resolveWithin(root, "/etc/passwd")).toBeUndefined();
  });
});

describe("collectOutboundFiles", () => {
  const cwd = "/proyecto";

  it("extrae líneas FILE: absolutas", () => {
    const text = "Listo.\nFILE: /proyecto/out/grafica.png";
    expect(collectOutboundFiles(text, cwd)).toEqual([
      "/proyecto/out/grafica.png",
    ]);
  });

  it("resuelve FILE: relativos contra cwd", () => {
    const text = "FILE: out/resultado.pdf";
    expect(collectOutboundFiles(text, cwd)).toEqual([
      path.resolve("/proyecto/out/resultado.pdf"),
    ]);
  });

  it("deduplica referencias repetidas", () => {
    const text = "FILE: /p/a.png\nFILE: /p/a.png\nver /p/a.png al final";
    expect(collectOutboundFiles(text, "/p")).toEqual(["/p/a.png"]);
  });

  it("ignora rutas inexistentes pero respeta FILE: existentes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "t2a-media-"));
    const existing = path.join(dir, "grafica.png");
    await writeFile(existing, "png");
    const files = collectOutboundFiles(
      `FILE: ${existing}\ny también /no/existe.png`,
      cwd,
    );
    expect(files).toEqual([existing]);
  });

  it("captura rutas relativas bare mencionadas por el agente (caso real de bug)", async () => {
    // El agente respondió con la ruta en backticks, sin FILE: y sin ./
    const dir = await mkdtemp(path.join(os.tmpdir(), "t2a-media-"));
    const image = path.join(dir, "examples", "sub");
    await mkdir(image, { recursive: true });
    const file = path.join(image, "base-bloomie-3000x3000.webp");
    await writeFile(file, "webp");

    const text = [
      "*Imagen encontrada y enviada*",
      "",
      "- Archivo: `examples/sub/base-bloomie-3000x3000.webp`",
    ].join("\n");

    const files = collectOutboundFiles(text, dir);
    expect(files).toEqual([file]);
  });

  it("acepta ./relativas y no confunde palabras sueltas con rutas", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "t2a-media-"));
    await writeFile(path.join(dir, "out.pdf"), "pdf");

    const withDot = collectOutboundFiles("mira `./out.pdf`", dir);
    expect(withDot).toEqual([path.join(dir, "out.pdf")]);

    // "webp" o "png" solos, sin ruta, no generan falsos positivos.
    expect(
      collectOutboundFiles("el formato webp es mejor que png", dir),
    ).toEqual([]);
  });
});
