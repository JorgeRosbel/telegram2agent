import { describe, expect, it } from "vitest";
import { parseOpencodeEvent } from "@/agents/opencode";

// Fixtures con la salida REAL de `opencode run "hola" -m … --format json`.

const STEP_START =
  '{"type":"step_start","timestamp":1787577696553,"sessionID":"ses_fcc112372ffe6XCYva2ow4XyjT","part":{"id":"prt_033ef011e001lYczZ3pahKWjGy","messageID":"msg_033eede1d001WaRaSo9pnB0C3J","sessionID":"ses_fcc112372ffe6XCYva2ow4XyjT","snapshot":"cd60e8ccb20930784229668d0a7ca3124842a1cf","type":"step-start"}}';

const TEXT_PART =
  '{"type":"text","timestamp":1787577697567,"sessionID":"ses_fcc112372ffe6XCYva2ow4XyjT","part":{"id":"prt_033ef03e800113yvipqGX5Z4I1","messageID":"msg_033eede1d001WaRaSo9pnB0C3J","sessionID":"ses_fcc112372ffe6XCYva2ow4XyjT","type":"text","text":"¡Hola! ¿En qué puedo ayudarte hoy?","time":{"start":1787577697256,"end":1787577697556}}}';

const STEP_FINISH =
  '{"type":"step_finish","timestamp":1787577697630,"sessionID":"ses_fcc112372ffe6XCYva2ow4XyjT","part":{"id":"prt_033ef05520015IIc00rA0BdO8A","reason":"stop","snapshot":"657d540eab647895f6f2035059eca3625c2ce16b","messageID":"msg_033eede1d001WaRaSo9pnB0C3J","sessionID":"ses_fcc112372ffe6XCYva2ow4XyjT","type":"step-finish","tokens":{"total":8775,"input":1439,"output":31,"reasoning":9,"cache":{"write":0,"read":7296}},"cost":0}}';

const REASONING_PART = JSON.stringify({
  type: "reasoning",
  timestamp: 1787577697500,
  sessionID: "ses_fcc112372ffe6XCYva2ow4XyjT",
  part: {
    id: "prt_reasoning_1",
    messageID: "msg_033eede1d001WaRaSo9pnB0C3J",
    sessionID: "ses_fcc112372ffe6XCYva2ow4XyjT",
    type: "reasoning",
    text: "El usuario saluda; respondo breve y en español.",
  },
});

describe("parseOpencodeEvent", () => {
  it('extrae el texto del evento {"type":"text"}', () => {
    const parsed = parseOpencodeEvent(TEXT_PART);
    expect(parsed.text).toBe("¡Hola! ¿En qué puedo ayudarte hoy?");
    expect(parsed.sessionId).toBe("ses_fcc112372ffe6XCYva2ow4XyjT");
    expect(parsed.costUsd).toBeUndefined();
  });

  it('extrae el thinking del evento {"type":"reasoning"}', () => {
    const parsed = parseOpencodeEvent(REASONING_PART);
    expect(parsed.thinking).toBe(
      "El usuario saluda; respondo breve y en español.",
    );
    expect(parsed.sessionId).toBe("ses_fcc112372ffe6XCYva2ow4XyjT");
    expect(parsed.text).toBeUndefined();
  });

  it("ignora step_start pero captura su sessionID", () => {
    const parsed = parseOpencodeEvent(STEP_START);
    expect(parsed.sessionId).toBe("ses_fcc112372ffe6XCYva2ow4XyjT");
    expect(parsed.text).toBeUndefined();
  });

  it("extrae el coste de step_finish", () => {
    const parsed = parseOpencodeEvent(STEP_FINISH);
    expect(parsed.costUsd).toBe(0);
    expect(parsed.text).toBeUndefined();
  });

  it("ignora líneas no-JSON (logs, ruido)", () => {
    expect(parseOpencodeEvent("opencode: booting server…")).toEqual({});
  });
});
