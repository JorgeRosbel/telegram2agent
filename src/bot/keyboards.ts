import { InlineKeyboard } from "grammy";
import type { AgentMode, AgentName } from "../agents/types";
import { KNOWN_CLAUDE_EFFORTS } from "../agents/claude";
import { KNOWN_OPENCODE_EFFORTS } from "../agents/opencode";

export function modelsKeyboard(models: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const model of models) {
    keyboard.text(model, `model:${model}`);
    keyboard.row();
  }
  return keyboard;
}

const AGENT_LABELS: Record<AgentName, string> = {
  claude: "🟠 Claude Code",
  opencode: "⬛ OpenCode",
};

export function agentsKeyboard(current: AgentName): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const agent of Object.keys(AGENT_LABELS) as AgentName[]) {
    const mark = agent === current ? " ✓" : "";
    keyboard.text(`${AGENT_LABELS[agent]}${mark}`, `agent:${agent}`);
    keyboard.row();
  }
  return keyboard;
}

export function approvalKeyboard(requestKey: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Aprobar", `perm:${requestKey}:1`)
    .text("❌ Denegar", `perm:${requestKey}:0`);
}

const MODE_LABELS: Record<AgentMode, string> = {
  plan: "📋 Plan (solo lectura)",
  edit: "✏️ Editar (aplica cambios)",
};

export const MODE_NAMES = Object.keys(MODE_LABELS) as AgentMode[];

export function modesKeyboard(current: AgentMode): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const mode of MODE_NAMES) {
    const mark = mode === current ? " ✓" : "";
    keyboard.text(`${MODE_LABELS[mode]}${mark}`, `mode:${mode}`);
    keyboard.row();
  }
  return keyboard;
}

export const AGENT_NAMES = Object.keys(AGENT_LABELS) as AgentName[];

/**
 * Reexporta los niveles tipados de cada adapter (fuente única de verdad:
 * `KNOWN_CLAUDE_EFFORTS` en claude.ts, `KNOWN_OPENCODE_EFFORTS` en
 * opencode.ts) — "none" (desactiva el razonamiento en OpenCode) se deja
 * fuera del teclado porque ya existe el botón "default" para no mandar
 * --variant en absoluto.
 */
const EFFORT_LEVELS: Record<AgentName, string[]> = {
  claude: [...KNOWN_CLAUDE_EFFORTS],
  opencode: [...KNOWN_OPENCODE_EFFORTS],
};

/** Niveles de reasoning effort que acepta cada CLI. */
export function effortLevels(agent: AgentName): string[] {
  return EFFORT_LEVELS[agent];
}

export function effortsKeyboard(
  agent: AgentName,
  current: string | undefined,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const levels = effortLevels(agent);
  for (const [index, level] of levels.entries()) {
    const mark = level === current ? " ✓" : "";
    keyboard.text(`${level}${mark}`, `effort:${level}`);
    if ((index + 1) % 3 === 0) keyboard.row();
  }
  const mark = current === undefined ? " ✓" : "";
  keyboard.text(`default${mark}`, "effort:default");
  return keyboard;
}
