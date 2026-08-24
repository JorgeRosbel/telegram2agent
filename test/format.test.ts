import { describe, expect, it } from "vitest";
import { sanitizeForTelegram, TELEGRAM_FORMAT_INSTRUCTION } from "@/bot/format";

describe("sanitizeForTelegram", () => {
  it("convierte negritas dobles **x** en *x*", () => {
    expect(sanitizeForTelegram("esto es **importante** aquí")).toBe(
      "esto es *importante* aquí",
    );
  });

  it("convierte encabezados # en negrita", () => {
    expect(sanitizeForTelegram("## Resultados\ncontenido")).toBe(
      "*Resultados*\ncontenido",
    );
    expect(sanitizeForTelegram("# Título")).toBe("*Título*");
  });

  it("convierte tablas en listas", () => {
    const table = [
      "| Modelo | Coste |",
      "|---|---|",
      "| sonnet | $0.01 |",
      "| opus   | $0.05 |",
    ].join("\n");
    expect(sanitizeForTelegram(table)).toBe(
      "- Modelo — Coste\n- sonnet — $0.01\n- opus — $0.05",
    );
  });

  it("elimina reglas horizontales", () => {
    expect(sanitizeForTelegram("arriba\n---\nabajo")).toBe("arriba\nabajo");
  });

  it("compacta saltos excesivos y recorta", () => {
    expect(sanitizeForTelegram("\n\na\n\n\n\nb\n\n")).toBe("a\n\nb");
  });
});

describe("TELEGRAM_FORMAT_INSTRUCTION", () => {
  it("prohíbe encabezados, tablas y ** dobles", () => {
    expect(TELEGRAM_FORMAT_INSTRUCTION).toContain("Nada de encabezados");
    expect(TELEGRAM_FORMAT_INSTRUCTION).toContain("tablas");
    expect(TELEGRAM_FORMAT_INSTRUCTION).toContain("*así*");
  });
});
