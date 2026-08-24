import { describe, expect, it } from "vitest";
import { effortLevels, effortsKeyboard } from "@/bot/keyboards";

describe("effortLevels", () => {
  it("expone los niveles que acepta cada CLI", () => {
    expect(effortLevels("claude")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortLevels("opencode")).toContain("minimal");
  });
});

describe("effortsKeyboard", () => {
  it("marca el nivel actual y añade el botón default", () => {
    const keyboard = effortsKeyboard("claude", "high");
    const texts = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(texts).toContain("high ✓");
    expect(texts).toContain("low");
    expect(texts).toContain("default");
    expect(texts).not.toContain("default ✓");
  });

  it("marca default cuando no hay effort elegido", () => {
    const keyboard = effortsKeyboard("opencode", undefined);
    const texts = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(texts).toContain("default ✓");
    expect(texts).not.toContain("default");
  });

  it("incluye el callback effort:<nivel> en cada botón", () => {
    const keyboard = effortsKeyboard("opencode", "max");
    const callbacks = keyboard.inline_keyboard
      .flat()
      .map((b) => ("callback_data" in b ? b.callback_data : undefined));
    expect(callbacks).toContain("effort:max");
    expect(callbacks).toContain("effort:default");
  });
});
