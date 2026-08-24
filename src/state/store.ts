import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMode, AgentName } from "../agents/types";

export interface PersistedState {
  /** Agente activo por defecto. */
  agent: AgentName;
  /** Modelo elegido por agente (persistente vía /model). */
  models: Partial<Record<AgentName, string>>;
  /** Modo de trabajo por agente (persistente vía /mode). */
  modes: Partial<Record<AgentName, AgentMode>>;
  /** Nivel de razonamiento por agente (persistente vía /effort). */
  efforts: Partial<Record<AgentName, string>>;
  /** Última sesión por chat y agente, para continuar con reply. */
  sessions: Record<string, Partial<Record<AgentName, string>>>;
}

export function emptyState(agent: AgentName = "claude"): PersistedState {
  return { agent, models: {}, modes: {}, efforts: {}, sessions: {} };
}

export class StateStore {
  private state: PersistedState;
  private readonly file: string;

  constructor(file: string, initial?: Partial<PersistedState>) {
    this.file = file;
    this.state = { ...emptyState(), ...initial };
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.state = {
        agent: parsed.agent ?? this.state.agent,
        models: { ...this.state.models, ...parsed.models },
        modes: { ...this.state.modes, ...parsed.modes },
        efforts: { ...this.state.efforts, ...parsed.efforts },
        sessions: { ...this.state.sessions, ...parsed.sessions },
      };
    } catch {
      // Archivo inexistente o corrupto → estado limpio.
    }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  get agent(): AgentName {
    return this.state.agent;
  }

  async setAgent(agent: AgentName): Promise<void> {
    this.state.agent = agent;
    await this.persist();
  }

  modelFor(agent: AgentName): string | undefined {
    return this.state.models[agent];
  }

  async setModel(agent: AgentName, model: string): Promise<void> {
    this.state.models[agent] = model;
    await this.persist();
  }

  modeFor(agent: AgentName, fallback: AgentMode = "edit"): AgentMode {
    return this.state.modes[agent] ?? fallback;
  }

  async setMode(agent: AgentName, mode: AgentMode): Promise<void> {
    this.state.modes[agent] = mode;
    await this.persist();
  }

  effortFor(agent: AgentName): string | undefined {
    return this.state.efforts[agent];
  }

  async setEffort(agent: AgentName, effort: string | undefined): Promise<void> {
    if (effort === undefined) delete this.state.efforts[agent];
    else this.state.efforts[agent] = effort;
    await this.persist();
  }

  sessionFor(chatId: number | string, agent: AgentName): string | undefined {
    return this.state.sessions[String(chatId)]?.[agent];
  }

  async setSession(
    chatId: number | string,
    agent: AgentName,
    sessionId: string,
  ): Promise<void> {
    const key = String(chatId);
    this.state.sessions[key] = {
      ...this.state.sessions[key],
      [agent]: sessionId,
    };
    await this.persist();
  }
}
