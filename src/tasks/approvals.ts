import type { PermissionRequest } from "../agents/types";

export interface PendingApproval {
  request: PermissionRequest;
  resolve(allowed: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Puente entre permisos del agente y respuestas de Telegram.
 * La capa de bot crea la aprobación, muestra los botones y resuelve
 * el callback con ✅/❌.
 */
export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly timeoutMs: number) {}

  /** Registra un permiso pendiente. Resuelve `false` al expirar el timeout. */
  create(
    key: string,
    request: PermissionRequest,
  ): Promise<boolean> & { key: string } {
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve(false);
      }, this.timeoutMs);
      this.pending.set(key, { request, resolve, timer });
    }) as Promise<boolean> & { key: string };
    promise.key = key;
    return promise;
  }

  /** Resuelve la aprobación desde un botón de Telegram. */
  answer(key: string, allowed: boolean): boolean {
    const pending = this.pending.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    pending.resolve(allowed);
    return true;
  }

  isPending(key: string): boolean {
    return this.pending.has(key);
  }
}
