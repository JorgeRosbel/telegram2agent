import { describe, expect, it } from "vitest";
import { parseOpencodeModels } from "@/agents/opencode";

const CLI_OUTPUT = [
  "opencode/big-pickle",
  "opencode/claude-haiku-4-5",
  "openai/gpt-5",
  "anthropic/claude-opus-4-6",
  "",
  // ruido típico de logs si se cuela:
  "[DEBUG] loading models cache",
].join("\n");

describe("parseOpencodeModels", () => {
  it("extrae solo líneas provider/model válidas y ordenadas", () => {
    expect(parseOpencodeModels(CLI_OUTPUT)).toEqual([
      "anthropic/claude-opus-4-6",
      "openai/gpt-5",
      "opencode/big-pickle",
      "opencode/claude-haiku-4-5",
    ]);
  });

  it("deduplica y descarga basura sin romperse", () => {
    const models = parseOpencodeModels("a/b\na/b\n\nno-valido");
    expect(models).toEqual(["a/b"]);
  });

  it("devuelve [] con salida vacía", () => {
    expect(parseOpencodeModels("")).toEqual([]);
  });
});
