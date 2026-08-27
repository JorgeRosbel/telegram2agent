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
| `/effort`                                | Reasoning effort por agente (`--effort` / `--variant`)              |
| `/config`                                | Ver la configuración actual (token enmascarado)                     |
| `/tasks`, `/status <id>`, `/cancel <id>` | Tareas en segundo plano                                             |
| `/file <ruta>`                           | Envía un archivo del proyecto (imágenes como foto)                  |

**Media saliente**: pide "envíame el resultado del cálculo" y el agente guarda el archivo; la lib detecta las líneas `FILE:` de su respuesta y lo envía por `sendPhoto`/`sendDocument`.

## API programática

```ts
bot.ask(prompt, { agent?, model?, onText? }): Promise<RunResult>
bot.run(prompt, { agent?, chatId? }): Task   // background + notificación automática
task.onDone(cb); task.status(); task.cancel()
bot.runStep(prompt, { agent?, chatId? }): Promise<RunResult> // como run(), pero awaitable
                                               // — encadena pasos con la misma sesión:
                                               //   await bot.runStep('paso 1');
                                               //   await bot.runStep('paso 2');
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
  defaults?: { agent?, model?, mode?, effort? };
  approvalTimeoutMs?: number;           // default 120_000
  taskTimeoutMs?: number;               // default 1_800_000
  shellEnabled?: boolean;               // default true — mensajes "!cmd" en la terminal
  shellTimeoutMs?: number;              // default 300_000 (5 min)
  autoMode?: boolean;                   // default false — sin aprobación por Telegram
  claude?: { models?, permissionMode?, timeoutMs?, usageLimitRetryMs?, bin? };
  opencode?: { models?, autoApprove?, timeoutMs?, bin? };
});
```

Notas:

- **`!comandos`**: cualquier chat de la `allow` puede ejecutar comandos arbitrarios en `cwd` (mismo nivel de confianza que el agente en modo edit). Aparecen en `/tasks` y se pueden cancelar con `/cancel <id>`; la salida se trunca a ~3.500 caracteres.
- **Claude Code**: el modelo usa alias nativos (`sonnet`, `opus`, `haiku`, `fable`, `opusplan`, `best`) o cualquier ID versionado (`claude-opus-5`, …). Sin aprobadores conectados corre con `--permission-mode acceptEdits`.
- **OpenCode**: declara sus modelos con `opencode: { models: ['anthropic/claude-sonnet-4', …] }`. La aprobación interactiva por botones es exclusiva de Claude en v1; OpenCode corre con permisos denegados salvo `autoApprove: true` (`--auto`).
- **`autoMode`**: auto mode real, sin botones ✅/❌ en Telegram. Claude corre con `--permission-mode bypassPermissions` (salta _todos_ los permisos, no solo ediciones de archivo); OpenCode corre con `autoApprove: true`. Se puede sobreescribir por agente pasando `claude: { permissionMode: '...' }` u `opencode: { autoApprove: false }` explícitamente. En modo `plan` nunca hay nada que aprobar, así que `autoMode` no cambia nada ahí.
- **Límite de uso del plan**: si Claude Code responde que se agotó tu ventana de uso (`You've hit your session limit · resets …`, `usage limit reached`, o un rate limit del API), la librería lo detecta y reintenta sola cada `usageLimitRetryMs` (default 10 min) hasta que se restablece — el bot sigue respondiendo a otros chats/comandos mientras tanto, y avisa una vez por Telegram al empezar a esperar. Aplica a `ask()`, `run()`/`runStep()` y al chat interactivo por igual; se cancela con `task.cancel()` / `/cancel <id>` como cualquier otra tarea.

## Chaining background tasks (real example)

`bot.runStep()` is `bot.run()` wrapped in a promise, so you can `await` a
sequence of background steps — each one continues the same Claude session
as the one before it (and the same session the interactive chat is using
for that `chatId`), and each step notifies the chat on its own when it's
done. This is a real, working example: point it at any GitHub repo you
have `gh` access to, and it summarizes the 5 most recent open issues into
one `.txt` file per issue.

```ts
import { createBot } from "@ariaskit/telegram2agent";

const REPO = "your-org/your-repo";

const bot = createBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  allow: [Number(process.env.ALLOWED_CHAT_ID)],
  cwd: process.cwd(),
  defaults: { agent: "claude", model: { claude: "sonnet" } },
  // No approval buttons for this run — it's just `gh` reads + local writes.
  autoMode: true,
});

// bot.start() only resolves once the bot stops (it's the long-polling
// loop) — don't await it before kicking off background work, or the code
// below never runs. Kick off the chain in parallel and await it at the end.
const listening = bot.start();

async function summarizeRecentIssues(): Promise<void> {
  await bot.notify(`🚀 Summarizing issues for ${REPO}…`);

  // Step 1: ask Claude to list issue numbers only, so we can parse them.
  const list = await bot.runStep(
    `Run 'gh issue list --repo ${REPO} --state open --limit 5 --json number' ` +
      "and reply with ONLY the issue numbers, comma-separated.",
  );
  const numbers = [...new Set(list.text.match(/\d+/g)?.map(Number) ?? [])];

  // Step 2..N: one chained step per issue — same session as step 1, so
  // Claude already has context on what it just listed.
  for (const n of numbers) {
    await bot.runStep(
      `Run 'gh issue view ${n} --repo ${REPO}', then write ` +
        `summaries/issue-${n}.txt with a <=50 char summary and a step-by-step fix.`,
    );
  }

  await bot.notify(`✅ Done — ${numbers.length} summaries written.`);
}

void summarizeRecentIssues().catch((error: Error) =>
  bot.notify(`⚠️ Chain failed: ${error.message}`),
);

await listening;
```

If Claude Code ever hits your usage window mid-chain — `You've hit your
session limit · resets 3:30am`, the older `usage limit reached`, or an API
rate limit — you don't need to handle that yourself. The library puts the
step to sleep and retries every 10 minutes (configurable via
`claude: { usageLimitRetryMs }`) until the limit resets, sends one Telegram
notice saying when it comes back, and then continues the chain right where
it left off. `taskTimeoutMs` is not consumed while sleeping: it measures the
agent's working time, not the wait. The rest of the bot (other chats,
`/tasks`, `!shell`) keeps working normally while one step waits.

A spend limit (`monthly spend limit`, `credit balance too low`) is _not_
treated this way — it doesn't lift on its own, so it fails immediately.

## Desarrollo

```sh
pnpm install
pnpm run verify    # lint + typecheck + test + build
pnpm tsx examples/quickstart.ts
```

## Publicar

Bump de versión en `package.json` + entrada en `CHANGELOG.md` → push a `main` → el workflow publica a npm con provenance.
