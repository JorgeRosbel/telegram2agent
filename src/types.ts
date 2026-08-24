export interface AgentRequest {
  /** Chat de Telegram de origen. */
  chatId: number;
  /** Usuario que envió el mensaje. */
  userId: number;
  /** Texto del mensaje recibido. */
  text: string;
}

export interface AgentResponse {
  /** Respuesta generada por el agente. */
  reply: string;
}
