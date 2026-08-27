import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "@/state/store";

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "t2a-store-"));
  return path.join(dir, "state.json");
}

describe("StateStore", () => {
  it("persiste el agente activo y los modelos elegidos", async () => {
    const file = await tmpFile();
    const store = new StateStore(file);
    await store.setAgent("opencode");
    await store.setModel("opencode", "anthropic/claude-sonnet-4");

    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.agent).toBe("opencode");
    expect(raw.models.opencode).toBe("anthropic/claude-sonnet-4");
    await rm(path.dirname(file), { recursive: true });
  });

  it("persiste y borra el effort por agente", async () => {
    const file = await tmpFile();
    const store = new StateStore(file);
    await store.setEffort("claude", "xhigh");
    expect(store.effortFor("claude")).toBe("xhigh");
    expect(store.effortFor("opencode")).toBeUndefined();

    const second = new StateStore(file);
    await second.load();
    expect(second.effortFor("claude")).toBe("xhigh");

    await second.setEffort("claude", undefined);
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.efforts.claude).toBeUndefined();
    await rm(path.dirname(file), { recursive: true });
  });

  it("recupera el estado tras reiniciar", async () => {
    const file = await tmpFile();
    const first = new StateStore(file);
    await first.setModel("claude", "sonnet");
    await first.setSession(123456, "claude", "ses-abc");

    const second = new StateStore(file);
    await second.load();
    expect(second.modelFor("claude")).toBe("sonnet");
    expect(second.sessionFor(123456, "claude")).toBe("ses-abc");
    expect(second.sessionFor(999999, "claude")).toBeUndefined();
    await rm(path.dirname(file), { recursive: true });
  });

  it("clearSession olvida la sesión sin tocar el resto del estado", async () => {
    const file = await tmpFile();
    const store = new StateStore(file);
    await store.setModel("claude", "opus");
    await store.setSession(123456, "claude", "ses-abc");
    await store.setSession(123456, "opencode", "ses-oc");

    await store.clearSession(123456, "claude");

    expect(store.sessionFor(123456, "claude")).toBeUndefined();
    // El otro agente y la configuración siguen intactos.
    expect(store.sessionFor(123456, "opencode")).toBe("ses-oc");
    expect(store.modelFor("claude")).toBe("opus");

    // Y el olvido sobrevive a un reinicio: no se queda solo en memoria.
    const reloaded = new StateStore(file);
    await reloaded.load();
    expect(reloaded.sessionFor(123456, "claude")).toBeUndefined();
    expect(reloaded.sessionFor(123456, "opencode")).toBe("ses-oc");
    await rm(path.dirname(file), { recursive: true });
  });

  it("clearSession sobre una sesión inexistente no rompe ni reescribe", async () => {
    const file = await tmpFile();
    const store = new StateStore(file);
    await expect(store.clearSession(999999, "claude")).resolves.toBeUndefined();
    await rm(path.dirname(file), { recursive: true });
  });

  it("no deja archivos temporales al persistir (escritura atómica)", async () => {
    const file = await tmpFile();
    const store = new StateStore(file);
    await store.setAgent("claude");

    const dir = path.dirname(file);
    const entries = await readFile(dir + "/state.json", "utf8");
    expect(entries).toContain('"agent": "claude"');
    await rm(dir, { recursive: true });
  });
});
