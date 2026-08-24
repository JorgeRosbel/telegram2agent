import { describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "@/agents/claude";
import { buildOpencodeArgs, OpencodeAdapter } from "@/agents/opencode";

// Estado hoisted para programar las líneas NDJSON que emitirá el fake spawn.
const state = vi.hoisted(() => ({ script: [] as string[] }));

vi.mock("@/agents/spawn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/agents/spawn")>();
  return {
    ...actual,
    spawnProcess: vi.fn(
      (
        _command: string,
        _args: string[],
        options: { onStdoutLine?: (line: string) => void },
      ) => {
        for (const line of state.script) options.onStdoutLine?.(line);
        return {
          close: Promise.resolve({ code: 0 }),
          controller: {
            writeStdin: () => undefined,
            endStdin: () => undefined,
            kill: async () => undefined,
          },
        };
      },
    ),
  };
});

describe("thinking acumulado (claude)", () => {
  it("acumula bloques thinking, notifica parciales y lo expone en RunResult", async () => {
    state.script = [
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: [{ type: "thinking", thinking: "paso uno" }] },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: [{ type: "thinking", thinking: "paso dos" }] },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: [{ type: "text", text: "respuesta final" }] },
      }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "respuesta final",
        session_id: "s1",
      }),
    ];

    const partials: string[] = [];
    const result = await new ClaudeAdapter()
      .run({ prompt: "x", onThinking: (t) => partials.push(t) })
      .result();

    expect(partials).toEqual(["paso uno", "paso uno\n\npaso dos"]);
    expect(result.thinking).toBe("paso uno\n\npaso dos");
    expect(result.text).toBe("respuesta final");
  });
});

describe("thinking acumulado (opencode)", () => {
  it('acumula eventos {"type":"reasoning"} y los expone en RunResult', async () => {
    state.script = [
      JSON.stringify({
        type: "reasoning",
        sessionID: "ses_1",
        part: { type: "reasoning", text: "analizo la petición" },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_1",
        part: { type: "text", text: "hola" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1",
        part: { reason: "stop", cost: 0 },
      }),
    ];

    const partials: string[] = [];
    const result = await new OpencodeAdapter()
      .run({ prompt: "x", onThinking: (t) => partials.push(t) })
      .result();

    expect(partials).toEqual(["analizo la petición"]);
    expect(result.thinking).toBe("analizo la petición");
    expect(result.text).toBe("hola");
    expect(result.sessionId).toBe("ses_1");
  });
});

describe("flag --thinking (opencode)", () => {
  it("incluye --thinking por defecto", () => {
    const args = buildOpencodeArgs({ prompt: "x" });
    expect(args).toContain("--thinking");
  });

  it("omite --thinking cuando thinking: false", () => {
    const args = buildOpencodeArgs({ prompt: "x" }, { thinking: false });
    expect(args).not.toContain("--thinking");
  });
});
