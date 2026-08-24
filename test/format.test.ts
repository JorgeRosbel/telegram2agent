import { describe, expect, it } from "vitest";
import {
  balanceFences,
  escapeHtml,
  sanitizeForTelegram,
  TELEGRAM_FORMAT_INSTRUCTION,
  toTelegramHtml,
} from "@/bot/format";

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

describe("toTelegramHtml", () => {
  it("convierte *negrita* en <b>", () => {
    expect(toTelegramHtml("esto es *importante* aquí")).toBe(
      "esto es <b>importante</b> aquí",
    );
  });

  it("convierte `código` en <code>", () => {
    expect(toTelegramHtml("ejecuta `pnpm test`")).toBe(
      "ejecuta <code>pnpm test</code>",
    );
  });

  it("convierte bloques cercados en <pre>", () => {
    const html = toTelegramHtml("mira:\n```js\nconst a = 1;\n```");
    expect(html).toContain("<pre>const a = 1;</pre>");
    expect(html).not.toContain("```");
  });

  it("escapa HTML crudo del agente", () => {
    expect(toTelegramHtml('usa <div> & "comillas"')).toBe(
      "usa &lt;div&gt; &amp; &quot;comillas&quot;",
    );
  });

  it("no convierte negritas dentro de código", () => {
    expect(toTelegramHtml("`valor *importante*`")).toBe(
      "<code>valor *importante*</code>",
    );
  });

  it("convierte enlaces [texto](url)", () => {
    expect(toTelegramHtml("[docs](https://example.com)")).toBe(
      '<a href="https://example.com">docs</a>',
    );
  });

  it("**dobles** pasan por sanitize y salen como <b>", () => {
    expect(toTelegramHtml("esto es **importante**")).toBe(
      "esto es <b>importante</b>",
    );
  });

  it("los encabezados sanitizados salen como <b>", () => {
    expect(toTelegramHtml("## Resultados")).toBe("<b>Resultados</b>");
  });
});

describe("balanceFences", () => {
  it("cierra un cerco impar", () => {
    expect(balanceFences("texto\n```js\ncodigo")).toBe(
      "texto\n```js\ncodigo\n```",
    );
  });

  it("deja intacto un texto balanceado", () => {
    const balanced = "```js\ncodigo\n```\nfin";
    expect(balanceFences(balanced)).toBe(balanced);
  });
});

describe("escapeHtml", () => {
  it("escapa los caracteres peligrosos de HTML", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("TELEGRAM_FORMAT_INSTRUCTION", () => {
  it("prohíbe encabezados, tablas y ** dobles", () => {
    expect(TELEGRAM_FORMAT_INSTRUCTION).toContain("Nada de encabezados");
    expect(TELEGRAM_FORMAT_INSTRUCTION).toContain("tablas");
    expect(TELEGRAM_FORMAT_INSTRUCTION).toContain("*así*");
  });
});
