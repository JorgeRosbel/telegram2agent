export type AgentName = "claude" | "opencode";

export interface PermissionRequest {
  /** Nombre de la herramienta que el agente quiere usar (p. ej. "Bash"). */
  tool: string;
  /** Resumen legible de la acción solicitada. */
  summary: string;
}

/** Modo de trabajo del agente: plan (solo lectura) o edit (aplica cambios). */
export type AgentMode = "plan" | "edit";

export interface RunOptions {
  prompt: string;
  model?: string;
  /** plan → solo lectura; edit → puede modificar (con aprobaciones). Default: edit. */
  mode?: AgentMode;
  /** Nivel de razonamiento (--effort en claude, --variant en opencode). */
  effort?: string;
  /** ID de sesión a continuar (--resume / --session). */
  sessionId?: string;
  cwd?: string;
  /** Archivos adjuntos descargados de Telegram (rutas absolutas). */
  files?: string[];
  /** Aprobación interactiva de acciones sensibles. */
  onPermission?: (request: PermissionRequest) => Promise<boolean>;
  /** Texto parcial mientras el agente trabaja. */
  onText?: (partialText: string) => void;
  /** Razonamiento (thinking) parcial acumulado, si el modelo lo emite. */
  onThinking?: (partialThinking: string) => void;
}

export interface RunResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  /** Razonamiento completo del run, si el modelo lo emitió. */
  thinking?: string;
}

export interface RunHandle {
  result(): Promise<RunResult>;
  cancel(): Promise<void>;
}

export interface AdapterOptions {
  cwd?: string;
  timeoutMs?: number;
  permissionMode?: string;
}

/**
 * Protocolo común para hablar con un agente CLI.
 * Cada implementación parsea los eventos NDJSON de su CLI.
 */
export interface AgentAdapter {
  readonly name: AgentName;
  listModels(): Promise<string[]>;
  run(options: RunOptions): RunHandle;
}
