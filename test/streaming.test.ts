import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { StreamEditor } from "@/bot/streaming";

function stubApi() {
  const edit = vi
    .fn<
      (
        chatId: number,
        messageId: number,
        text: string,
        extra?: unknown,
      ) => Promise<unknown>
    >()
    .mockResolvedValue({});
  const send = vi
    .fn<(chatId: number, text: string, extra?: unknown) => Promise<unknown>>()
    .mockResolvedValue({ message_id: 1 });
  const api = { editMessageText: edit, sendMessage: send } as unknown as Api;
  return { api, edit, send };
}

describe("StreamEditor con HTML", () => {
  it("edita los parciales con parse_mode HTML", async () => {
    const { api, edit } = stubApi();
    const editor = new StreamEditor(api, 1, "HTML");
    await editor.start("trabajando…");
    editor.update("hola *mundo*");
    await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    const [chatId, messageId, text, extra] = edit.mock.calls[0]!;
    expect(chatId).toBe(1);
    expect(messageId).toBe(1);
    expect(text).toBe("hola *mundo*");
    expect(extra).toEqual({ parse_mode: "HTML" });
  });

  it("sin parse_mode edita en plano (compatibilidad)", async () => {
    const { api, edit } = stubApi();
    const editor = new StreamEditor(api, 1);
    await editor.start("x");
    editor.update("texto");
    await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    expect(edit.mock.calls[0]![3]).toBeUndefined();
  });

  it("reintenta en plano si Telegram rechaza el HTML", async () => {
    const { api, edit } = stubApi();
    edit.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"));
    const editor = new StreamEditor(api, 7, "HTML");
    await editor.start("x");
    editor.update("<pre>bloque sin cerrar");
    await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
    expect(edit.mock.calls[1]![3]).toBeUndefined();
  });

  it("divide el final en chunks reabriendo <pre> cortado", async () => {
    const { api, edit, send } = stubApi();
    const editor = new StreamEditor(api, 1, "HTML");
    await editor.start("x");
    await editor.finish(`<pre>${"a".repeat(4100)}</pre>`);
    expect(edit).toHaveBeenCalledTimes(1);
    // 1 del start + 1 del chunk que no cabe en el mensaje editado.
    expect(send).toHaveBeenCalledTimes(2);
    const chunk2 = send.mock.calls[1]![1] as string;
    expect(chunk2.startsWith("<pre>")).toBe(true);
    expect(chunk2.endsWith("</pre>")).toBe(true);
  });
});
