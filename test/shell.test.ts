import os from "node:os";
import { describe, expect, it } from "vitest";
import { parseShellCommand, runShell } from "@/bot/shell";

describe("parseShellCommand", () => {
  it("extrae el comando tras el prefijo !", () => {
    expect(parseShellCommand("!pnpm install react")).toBe("pnpm install react");
  });

  it("recorta espacios alrededor del comando", () => {
    expect(parseShellCommand("!   ls -la  ")).toBe("ls -la");
  });

  it("devuelve undefined sin prefijo o comando vacío", () => {
    expect(parseShellCommand("hola agente")).toBeUndefined();
    expect(parseShellCommand("!")).toBeUndefined();
    expect(parseShellCommand("!   ")).toBeUndefined();
  });
});

describe("runShell", () => {
  it("captura stdout y exit 0", async () => {
    const result = await runShell("echo hola", { cwd: os.tmpdir() }).result();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hola");
    expect(result.killed).toBe(false);
  });

  it("captura stderr y códigos de salida distintos de 0", async () => {
    const result = await runShell("echo boom >&2; exit 3", {
      cwd: os.tmpdir(),
    }).result();
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
    expect(result.killed).toBe(false);
  });

  it("respeta el cwd indicado", async () => {
    const result = await runShell("pwd", { cwd: process.cwd() }).result();
    expect(result.stdout.trim()).toBe(process.cwd());
  });

  it("mata el proceso al superar el timeout", async () => {
    const result = await runShell("sleep 5", {
      cwd: os.tmpdir(),
      timeoutMs: 200,
    }).result();
    expect(result.killed).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it("cancel() mata el árbol de procesos", async () => {
    const handle = runShell("sleep 5", { cwd: os.tmpdir(), timeoutMs: 0 });
    const pending = handle.result();
    await new Promise((resolve) => setTimeout(resolve, 100));
    handle.cancel();
    const result = await pending;
    expect(result.killed).toBe(true);
    expect(result.signal).toBe("SIGTERM");
  });

  it("trunca la salida que supera maxOutputBytes", async () => {
    const result = await runShell("head -c 200000 /dev/zero | tr '\\0' a", {
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxOutputBytes: 1_000,
    }).result();
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1_100);
  });
});
