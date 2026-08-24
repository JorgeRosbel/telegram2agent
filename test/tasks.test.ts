import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalBridge } from "@/tasks/approvals";
import { TaskRegistry } from "@/tasks/registry";

describe("TaskRegistry / Task", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("crea tareas con id incremental y las lista como running", () => {
    const registry = new TaskRegistry(60_000);
    const a = registry.create("tarea a", 1);
    const b = registry.create("tarea b", 1);
    expect(a.id).toBeLessThan(b.id);
    expect(registry.running()).toHaveLength(2);
  });

  it("marca done al completar y notifica listeners", () => {
    const registry = new TaskRegistry(60_000);
    const task = registry.create("refactor", 42);
    const seen: string[] = [];
    task.onDone(({ task: t }) => seen.push(`${t.id}:${t.status}`));

    task.complete({ ok: true, text: "listo" });
    expect(task.status).toBe("done");
    expect(seen).toEqual([`${task.id}:done`]);
    expect(registry.running()).toHaveLength(0);
  });

  it("ejecuta el listener inmediatamente si la tarea ya terminó", () => {
    const registry = new TaskRegistry(60_000);
    const task = registry.create("x", 1);
    task.fail(new Error("boom"));

    let called = false;
    task.onDone(({ error }) => {
      called = true;
      expect(error?.message).toBe("boom");
    });
    expect(called).toBe(true);
  });

  it("cancela la tarea vía bind y detiene su timeout", async () => {
    const registry = new TaskRegistry(1000);
    const task = registry.create("larga", 1);
    let cancelled = false;
    task.bind(async () => {
      cancelled = true;
    });

    void vi.advanceTimersByTimeAsync(2000);
    await task.cancel();
    expect(cancelled).toBe(true);
    expect(task.status).toBe("cancelled");
  });
});

describe("ApprovalBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resuelve con la respuesta del botón ✅/❌", async () => {
    const bridge = new ApprovalBridge(5000);
    const promise = bridge.create("k1", { tool: "Bash", summary: "ls" });

    expect(bridge.answer("k1", true)).toBe(true);
    await expect(promise).resolves.toBe(true);
    // Una segunda respuesta ya no encuentra la petición.
    expect(bridge.answer("k1", false)).toBe(false);
  });

  it("deniega automáticamente al expirar el timeout", async () => {
    const bridge = new ApprovalBridge(1000);
    const promise = bridge.create("k2", { tool: "Write", summary: "" });

    void vi.advanceTimersByTimeAsync(1500);
    await expect(promise).resolves.toBe(false);
  });
});
