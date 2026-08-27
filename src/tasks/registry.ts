import type { RunResult } from "../agents/types";

export type TaskStatus = "running" | "done" | "failed" | "cancelled";

export interface TaskDoneInfo {
  task: Task;
  result?: RunResult;
  error?: Error;
}

let nextTaskId = 1;

export class Task {
  readonly id = nextTaskId++;
  readonly description: string;
  readonly chatId: number | string;
  readonly startedAt = Date.now();
  status: TaskStatus = "running";
  result?: RunResult;
  error?: Error;
  endedAt?: number;

  private cancelFn?: () => Promise<void>;
  private listeners: Array<(info: TaskDoneInfo) => void> = [];
  private timeoutHandle?: ReturnType<typeof setTimeout>;
  private remainingMs: number;
  private armedAt = Date.now();
  private waitingSince?: number;
  /** Tiempo total que el reloj estuvo parado esperando fuera del agente. */
  private pausedMs = 0;

  constructor(description: string, chatId: number | string, timeoutMs: number) {
    this.description = description;
    this.chatId = chatId;
    this.remainingMs = timeoutMs;
    this.arm();
  }

  private arm(): void {
    if (this.remainingMs <= 0) return;
    this.armedAt = Date.now();
    this.timeoutHandle = setTimeout(() => {
      void this.cancel();
    }, this.remainingMs);
  }

  /**
   * Para el reloj del timeout. El plazo mide trabajo del agente, no las
   * esperas ajenas a él: si se agotó el límite de uso del plan, el run se
   * queda dormido hasta que se restablezca (horas, potencialmente) y sería
   * absurdo cancelar la tarea por ello. Idempotente.
   */
  pauseTimeout(): void {
    if (this.timeoutHandle === undefined || this.waitingSince !== undefined) {
      return;
    }
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = undefined;
    this.remainingMs = Math.max(
      0,
      this.remainingMs - (Date.now() - this.armedAt),
    );
    this.waitingSince = Date.now();
  }

  /** Reanuda el reloj con el plazo que quedaba. Idempotente. */
  resumeTimeout(): void {
    if (this.waitingSince === undefined) return;
    this.pausedMs += Date.now() - this.waitingSince;
    this.waitingSince = undefined;
    if (this.status === "running") this.arm();
  }

  /** Milisegundos que la tarea pasó dormida esperando el reset del límite. */
  get waitingMs(): number {
    const open =
      this.waitingSince !== undefined ? Date.now() - this.waitingSince : 0;
    return this.pausedMs + open;
  }

  /** Conecta la tarea con el run del adapter. Uso interno. */
  bind(cancel: () => Promise<void>): void {
    this.cancelFn = cancel;
  }

  onDone(listener: (info: TaskDoneInfo) => void): void {
    if (this.status !== "running") {
      listener({ task: this, result: this.result, error: this.error });
      return;
    }
    this.listeners.push(listener);
  }

  get elapsedMs(): number {
    return (this.endedAt ?? Date.now()) - this.startedAt;
  }

  async cancel(): Promise<void> {
    if (this.status !== "running") return;
    this.status = "cancelled";
    this.endedAt = Date.now();
    clearTimeout(this.timeoutHandle);
    await this.cancelFn?.();
    this.emit();
  }

  /** Uso interno: marca finalización exitosa. */
  complete(result: RunResult): void {
    if (this.status !== "running") return;
    this.status = "done";
    this.result = result;
    this.endedAt = Date.now();
    clearTimeout(this.timeoutHandle);
    this.emit();
  }

  /** Uso interno: marca fallo. */
  fail(error: Error): void {
    if (this.status !== "running") return;
    this.status = "failed";
    this.error = error;
    this.endedAt = Date.now();
    clearTimeout(this.timeoutHandle);
    this.emit();
  }

  private emit(): void {
    const info: TaskDoneInfo = {
      task: this,
      result: this.result,
      error: this.error,
    };
    for (const listener of this.listeners.splice(0)) {
      try {
        listener(info);
      } catch (error) {
        console.error("[telegram2agent] error en listener onDone:", error);
      }
    }
  }
}

export class TaskRegistry {
  private readonly tasks = new Map<number, Task>();

  constructor(private readonly defaultTimeoutMs: number) {}

  create(
    description: string,
    chatId: number | string,
    timeoutMs = this.defaultTimeoutMs,
  ): Task {
    const task = new Task(description, chatId, timeoutMs);
    this.tasks.set(task.id, task);
    task.onDone(() => undefined); // mantiene referencia hasta terminar
    return task;
  }

  get(id: number): Task | undefined {
    return this.tasks.get(id);
  }

  running(): Task[] {
    return [...this.tasks.values()].filter((task) => task.status === "running");
  }

  recent(limit = 10): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.id - a.id).slice(0, limit);
  }
}
