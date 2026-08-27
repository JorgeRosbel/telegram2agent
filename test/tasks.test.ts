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

  // Regresión: el plazo de la tarea se comía las horas que el run pasa
  // dormido esperando el reset del límite de uso, y la cancelaba a mitad.
  it("no consume el plazo mientras el reloj está pausado", async () => {
    const registry = new TaskRegistry(60_000);
    const task = registry.create("tarea", 1);

    task.pauseTimeout();
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 5 min dormida
    expect(task.status).toBe("running");

    task.resumeTimeout();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(task.status).toBe("running");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(task.status).toBe("cancelled");
  });

  it("descuenta el tiempo ya trabajado al reanudar el reloj", async () => {
    const registry = new TaskRegistry(60_000);
    const task = registry.create("tarea", 1);

    await vi.advanceTimersByTimeAsync(50_000); // 50 s de trabajo real
    task.pauseTimeout();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    task.resumeTimeout();

    // Quedaban 10 s, no 60.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(task.status).toBe("running");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(task.status).toBe("cancelled");
  });

  it("pausar y reanudar son idempotentes y contabilizan la espera", async () => {
    const registry = new TaskRegistry(60_000);
    const task = registry.create("tarea", 1);

    task.pauseTimeout();
    task.pauseTimeout();
    await vi.advanceTimersByTimeAsync(120_000);
    task.resumeTimeout();
    task.resumeTimeout();

    expect(task.status).toBe("running");
    expect(task.waitingMs).toBe(120_000);
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
