import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "@/agents/claude";

/**
 * Regresión: con `--input-format stream-json` la CLI de Claude sigue
 * esperando mensajes por stdin después de emitir su `result`. Si el adaptador
 * resuelve la promesa sin cerrar stdin, el proceso queda vivo para siempre y
 * cada turno encadenado fuga un `claude` entero.
 */

const state = vi.hoisted(() => ({
  scripts: [] as string[][],
  emitAsync: false,
  neverClose: false,
  endStdin: 0,
  kill: 0,
}));

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
        const script = state.scripts.shift() ?? [];
        const emit = (): void => {
          for (const line of script) options.onStdoutLine?.(line);
        };
        if (state.emitAsync) queueMicrotask(emit);
        else emit();
        return {
          close: state.neverClose
            ? new Promise<{ code: number | null }>(() => {})
            : Promise.resolve({ code: 0 }),
          controller: {
            writeStdin: () => undefined,
            endStdin: () => {
              state.endStdin += 1;
            },
            kill: async () => {
              state.kill += 1;
            },
          },
        };
      },
    ),
  };
});

const resultLine = (text: string, isError = false): string =>
  JSON.stringify({
    type: "result",
    is_error: isError,
    result: text,
    session_id: "s1",
  });

afterEach(() => {
  vi.useRealTimers();
  state.scripts = [];
  state.emitAsync = false;
  state.neverClose = false;
  state.endStdin = 0;
  state.kill = 0;
});

describe("recogida del proceso tras cada turno", () => {
  it("cierra stdin cuando llega el result (emisión asíncrona)", async () => {
    state.emitAsync = true;
    state.scripts = [[resultLine("listo")]];

    const result = await new ClaudeAdapter().run({ prompt: "x" }).result();

    expect(result.text).toBe("listo");
    expect(state.endStdin).toBe(1);
  });

  it("cierra stdin aunque el result llegue de forma síncrona al spawnear", async () => {
    state.scripts = [[resultLine("listo")]];

    await new ClaudeAdapter().run({ prompt: "x" }).result();

    expect(state.endStdin).toBe(1);
  });

  it("mata el proceso si tras el EOF no termina dentro del margen", async () => {
    vi.useFakeTimers();
    state.emitAsync = true;
    state.neverClose = true;
    state.scripts = [[resultLine("listo")]];

    await new ClaudeAdapter().run({ prompt: "x" }).result();
    expect(state.endStdin).toBe(1);
    expect(state.kill).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.kill).toBe(1);
  });

  // Regresión completa del incidente: con el texto real del CLI, el run debe
  // dormir y reintentar, no propagar el error al llamante.
  it("duerme y reintenta ante el límite de sesión real, sin fallar", async () => {
    state.emitAsync = true;
    state.scripts = [
      [
        resultLine(
          "You've hit your session limit · resets 3:30am (Europe/Madrid)",
          true,
        ),
      ],
      [resultLine("issue resuelta")],
    ];

    const waits: Array<{ attempt: number; resetsAt?: string }> = [];
    const result = await new ClaudeAdapter({ usageLimitRetryMs: 1 })
      .run({
        prompt: "x",
        onUsageLimitWait: (info) =>
          waits.push({ attempt: info.attempt, resetsAt: info.resetsAt }),
      })
      .result();

    expect(result.text).toBe("issue resuelta");
    expect(waits).toEqual([{ attempt: 1, resetsAt: "3:30am (Europe/Madrid)" }]);
    expect(state.endStdin).toBe(2);
  });

  it("recoge también el intento que agotó el límite de uso, antes de reintentar", async () => {
    state.emitAsync = true;
    state.scripts = [
      [resultLine("Claude usage limit reached", true)],
      [resultLine("listo")],
    ];

    const result = await new ClaudeAdapter({ usageLimitRetryMs: 1 })
      .run({ prompt: "x" })
      .result();

    expect(result.text).toBe("listo");
    // Uno por intento: el que falló por límite y el que lo consiguió.
    expect(state.endStdin).toBe(2);
  });
});
