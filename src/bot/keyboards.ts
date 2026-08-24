import { InlineKeyboard } from "grammy";
import type { AgentMode, AgentName } from "../agents/types";

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
