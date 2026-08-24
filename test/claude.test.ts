import { describe, expect, it } from "vitest";
import {
  buildControlResponse,
  buildPrompt,
  FILE_PROTOCOL_INSTRUCTION,
  parseClaudeEvent,
} from "@/agents/claude";

// Fixtures basados en el protocolo documentado de `claude -p --output-format stream-json`.

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "3f2a-abc",
  tools: ["Bash", "Read"],
});

const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  session_id: "3f2a-abc",
  message: {
    content: [
      { type: "text", text: "Voy a revisar el módulo auth." },
      { type: "tool_use", id: "t1", name: "Read" },
    ],
  },
});

const THINKING_ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  session_id: "3f2a-abc",
  message: {
    content: [
      { type: "thinking", thinking: "El usuario pide X; reviso auth primero." },
      { type: "text", text: "Voy a revisar el módulo auth." },
    ],
  },
});

const PERMISSION_LINE = JSON.stringify({
  type: "control_request",
  request_id: "req-123",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "rm -rf dist", description: "limpiar build" },
  },
});

const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Listo, refactor terminado.\nFILE: /tmp/grafica.png",
  session_id: "3f2a-abc",
  total_cost_usd: 0.0184,
  duration_ms: 8210,
});

describe("parseClaudeEvent", () => {
  it("extrae texto parcial de los mensajes del asistente", () => {
    const parsed = parseClaudeEvent(ASSISTANT_LINE);
    expect(parsed.text).toBe("Voy a revisar el módulo auth.");
    expect(parsed.sessionId).toBe("3f2a-abc");
  });

  it("extrae el thinking de los bloques del asistente", () => {
    const parsed = parseClaudeEvent(THINKING_ASSISTANT_LINE);
    expect(parsed.thinking).toBe("El usuario pide X; reviso auth primero.");
    expect(parsed.text).toBe("Voy a revisar el módulo auth.");
  });

  it("no confunde thinking con text", () => {
    const parsed = parseClaudeEvent(THINKING_ASSISTANT_LINE);
    expect(parsed.thinking).not.toContain("Voy a revisar");
  });

  it("convierte un control_request en petición de permiso", () => {
    const parsed = parseClaudeEvent(PERMISSION_LINE);
    expect(parsed.permission).toEqual({
      requestId: "req-123",
      request: {
        tool: "Bash",
        summary: "rm -rf dist",
      },
    });
  });

  it("parsea el resultado final con coste y duración", () => {
    const parsed = parseClaudeEvent(RESULT_LINE);
    expect(parsed.result).toEqual({
      ok: true,
      text: "Listo, refactor terminado.\nFILE: /tmp/grafica.png",
      sessionId: "3f2a-abc",
      costUsd: 0.0184,
      durationMs: 8210,
    });
  });

  it("devuelve {} para líneas no-JSON o desconocidas", () => {
    expect(parseClaudeEvent("no soy json")).toEqual({});
    expect(parseClaudeEvent(INIT_LINE)).toEqual({ sessionId: "3f2a-abc" });
  });
});

describe("buildControlResponse", () => {
  it("permite con behavior allow", () => {
    const response = JSON.parse(buildControlResponse("req-123", true));
    expect(response.type).toBe("control_response");
    expect(response.response.request_id).toBe("req-123");
    expect(response.response.response.behavior).toBe("allow");
  });

  it("deniega con behavior deny", () => {
    const response = JSON.parse(buildControlResponse("req-1", false));
    expect(response.response.response.behavior).toBe("deny");
    expect(response.response.response.message).toContain("Telegram");
  });
});

describe("buildPrompt", () => {
  it("incluye adjuntos e instrucción FILE:", () => {
    const prompt = buildPrompt({
      prompt: "hazme una gráfica",
      files: ["/tmp/datos.csv"],
    });
    expect(prompt).toContain("hazme una gráfica");
    expect(prompt).toContain("/tmp/datos.csv");
    expect(prompt).toContain(FILE_PROTOCOL_INSTRUCTION);
  });
});
