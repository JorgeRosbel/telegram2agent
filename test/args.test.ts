import { describe, expect, it } from "vitest";
import { buildClaudeArgs } from "@/agents/claude";
import { buildOpencodeArgs } from "@/agents/opencode";

describe("buildClaudeArgs", () => {
  it("siempre inyecta el formato Telegram vía --append-system-prompt", () => {
    const args = buildClaudeArgs({ prompt: "hola" });
    const index = args.indexOf("--append-system-prompt");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toContain("Telegram");
  });

  it("modo plan usa --permission-mode plan", () => {
    const args = buildClaudeArgs({ prompt: "x", mode: "plan" });
    expect(args.join(" ")).toContain("--permission-mode plan");
  });

  it("modo edit sin aprobador cae a acceptEdits", () => {
    const args = buildClaudeArgs({ prompt: "x", mode: "edit" });
    expect(args.join(" ")).toContain("--permission-mode acceptEdits");
  });

  it("modo edit con aprobador no fuerza permission-mode (preguntará por control_request)", () => {
    const args = buildClaudeArgs({
      prompt: "x",
      mode: "edit",
      onPermission: async () => true,
    });
    expect(args.join(" ")).not.toContain("--permission-mode");
  });

  it("resume de sesión con --resume", () => {
    const args = buildClaudeArgs({ prompt: "x", sessionId: "ses-1" });
    expect(args.join(" ")).toContain("--resume ses-1");
  });

  it("reasoning effort con --effort solo si se pide", () => {
    expect(buildClaudeArgs({ prompt: "x" })).not.toContain("--effort");
    const args = buildClaudeArgs({ prompt: "x", effort: "high" });
    expect(args.join(" ")).toContain("--effort high");
  });
});

describe("buildOpencodeArgs", () => {
  it("usa --agent plan en modo plan", () => {
    const args = buildOpencodeArgs({ prompt: "hola", mode: "plan" });
    expect(args.slice(0, -1).join(" ")).toContain("--agent plan");
    // El formato va antepuesto al prompt (posicional final).
    expect(args.at(-1)).toContain("chat de Telegram");
    expect(args.at(-1)).toContain("hola");
  });

  it("en modo edit añade --auto solo si autoApprove", () => {
    expect(buildOpencodeArgs({ prompt: "x", mode: "edit" })).not.toContain(
      "--auto",
    );
    expect(
      buildOpencodeArgs({ prompt: "x", mode: "edit" }, { autoApprove: true }),
    ).toContain("--auto");
  });

  it("modelo y sesión con sus flags", () => {
    const args = buildOpencodeArgs({
      prompt: "x",
      model: "opencode/x-preview-f-free",
      sessionId: "ses_9",
    });
    expect(args).toContain("--model");
    expect(args).toContain("opencode/x-preview-f-free");
    expect(args.join(" ")).toContain("--session ses_9");
  });

  it("archivos adjuntos como --file", () => {
    const args = buildOpencodeArgs({ prompt: "x", files: ["/tmp/f.png"] });
    expect(args.join(" ")).toContain("--file /tmp/f.png");
  });

  it("reasoning effort con --variant solo si se pide", () => {
    expect(buildOpencodeArgs({ prompt: "x" })).not.toContain("--variant");
    const args = buildOpencodeArgs({ prompt: "x", effort: "max" });
    expect(args.join(" ")).toContain("--variant max");
  });
});
