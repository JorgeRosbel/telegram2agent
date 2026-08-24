# @ariaskit/telegram2agent

Controla **Claude Code** u **OpenCode** desde Telegram, de forma segura: allowlist por chat ID, streaming de respuestas, aprobación de acciones sensibles con botones ✅/❌, tareas en segundo plano y entrega de archivos (screenshots, PDFs, gráficas) directo al chat.

```ts
import { createBot } from "@ariaskit/telegram2agent";

const bot = createBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  allow: [123456789], // solo este chat recibe respuesta
  cwd: "~/webs/mi-proyecto",
  defaults: { agent: "claude", model: { claude: "sonnet" } },
});

await bot.start();

// "avísame cuando X esté listo" — tarea en segundo plano:
bot.run("genera los screenshots del sitio").onDone((info) => {
  console.log("listo:", info.result?.text);
});
```

## Seguridad

- **Allowlist estricta**: todo update de un chat fuera de `allow` se ignora antes de tocar ningún handler.
- **Aprobación humana**: cuando Claude quiere ejecutar una acción sensible (bash, escritura), llega un mensaje con botones _Aprobar/Denegar_; sin respuesta en `approvalTimeoutMs` (120s default) se **deniega** automáticamente.
- **`/file` contenido**: solo resuelve rutas dentro de `cwd` (protegido contra `../`).
- **Timeouts**: cada run tiene timeout (30 min default) y cancelación que mata el árbol de procesos.

## Desde Telegram

| Acción                                   | Resultado                                                           |
| ---------------------------------------- | ------------------------------------------------------------------- |
| Mensaje de texto                         | Pregunta al agente activo; respuesta con streaming + coste/duración |
| `!comando` (ej. `!pnpm test`)            | Ejecuta el comando en la terminal del proyecto y devuelve su salida |
| Responder (reply) a un mensaje del bot   | Continúa esa sesión exacta (`--resume` / `--session`)               |
| Foto o documento                         | Se descarga y llega como adjunto al agente                          |
| `/model`                                 | Inline keyboard; la elección queda como **default persistente**     |
| `/agent`                                 | Cambiar entre Claude Code y OpenCode                                |
| `/tasks`, `/status <id>`, `/cancel <id>` | Tareas en segundo plano                                             |
| `/file <ruta>`                           | Envía un archivo del proyecto (imágenes como foto)                  |

**Media saliente**: pide "envíame el resultado del cálculo" y el agente guarda el archivo; la lib detecta las líneas `FILE:` de su respuesta y lo envía por `sendPhoto`/`sendDocument`.

## API programática

```ts
bot.ask(prompt, { agent?, model?, onText? }): Promise<RunResult>
bot.run(prompt, { agent?, chatId? }): Task   // background + notificación automática
task.onDone(cb); task.status(); task.cancel()
bot.notify(text)                              // push directo a tu chat
bot.registry.running()                        // tareas en curso
bot.grammy                                    // instancia grammY para extender
```

`RunResult` incluye `text`, `sessionId`, `costUsd` y `durationMs`.

## Configuración

```ts
createBot({
  token: string;
  allow: Array<number | string>;        // chat IDs o "@username"
  cwd?: string;
  dbPath?: string;                      // default <cwd>/.telegram2agent.json
  defaults?: { agent?, model? };
  approvalTimeoutMs?: number;           // default 120_000
  taskTimeoutMs?: number;               // default 1_800_000
  shellEnabled?: boolean;               // default true — mensajes "!cmd" en la terminal
  shellTimeoutMs?: number;              // default 300_000 (5 min)
  claude?: { models?, permissionMode?, timeoutMs?, bin? };
  opencode?: { models?, autoApprove?, timeoutMs?, bin? };
});
```

Notas:

- **`!comandos`**: cualquier chat de la `allow` puede ejecutar comandos arbitrarios en `cwd` (mismo nivel de confianza que el agente en modo edit). Aparecen en `/tasks` y se pueden cancelar con `/cancel <id>`; la salida se trunca a ~3.500 caracteres.
- **Claude Code**: el modelo usa alias nativos (`sonnet`, `opus`, `haiku`). Sin aprobadores conectados corre con `--permission-mode acceptEdits`.
- **OpenCode**: declara sus modelos con `opencode: { models: ['anthropic/claude-sonnet-4', …] }`. La aprobación interactiva por botones es exclusiva de Claude en v1; OpenCode corre con permisos denegados salvo `autoApprove: true` (`--auto`).

## Desarrollo

```sh
pnpm install
pnpm run verify    # lint + typecheck + test + build
pnpm tsx examples/quickstart.ts
```

## Publicar

Bump de versión en `package.json` + entrada en `CHANGELOG.md` → push a `main` → el workflow publica a npm con provenance.
