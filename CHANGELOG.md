# Changelog

## 0.4.1

### Fixed

- `createBot` sin `defaults.agent` dejaba el bot inutilizable: el `{ agent: undefined }` explícito que se pasaba al `StateStore` pisaba el default del spread, así que `store.agent` quedaba sin valor y cualquier `resolveAgent()` reventaba con `undefined is not an object`. Afectaba a `ask`, `run`, `runStep` y `resetSession` por igual, en cualquier bot que no fijara el agente por defecto y no tuviera estado previo en disco.
- `resolveAgent()` cae a `claude` en vez de reventar si el estado persistido nombra un agente que este build no conoce.

## 0.4.0

### Added

- `bot.resetSession({ agent?, chatId? })`: olvida la sesión guardada para que el siguiente `ask`/`run`/`runStep` arranque una conversación nueva en vez de reanudar la anterior con `--resume`. Encadenar decenas de trabajos independientes en una sola sesión la hacía crecer sin techo — medido en un caso real: 5942 turnos y 4,4 MB tras 56 issues, con cada paso reanudando el historial completo de las anteriores. Resetear entre unidades de trabajo que no comparten contexto corta ese crecimiento. Los modelos/efforts persistidos no se tocan.
- `StateStore.clearSession(chatId, agent)`, que es lo que usa por debajo.

## 0.3.0

### Fixed

- **Fuga de procesos `claude` (crítico).** Con `--input-format stream-json` la CLI sigue esperando mensajes por stdin después de emitir su `result`, y el adaptador resolvía la promesa sin cerrarlo: cada turno dejaba vivo un proceso `claude` entero. Encadenar pasos con `runStep` acababa agotando la RAM de la máquina — en un caso real, 164 procesos ocupando 28,6 GB entre RAM y swap, hasta que el OOM killer del kernel se llevó por delante la sesión de escritorio del usuario. Ahora stdin se cierra en cuanto el turno se asienta, con SIGTERM de respaldo si el proceso no sale en 10 s.
- **El límite de uso ya no se detectaba (crítico).** `isUsageLimitError` solo casaba con la frase antigua `usage limit reached`, pero `claude` 2.1.x dice `You've hit your session limit · resets 3:30am (Europe/Madrid)`. El run fallaba en vez de dormir, así que un script encadenado quemaba una issue tras otra durante toda la ventana del límite. La detección cubre ahora la plantilla `You've hit your … limit` (session, weekly, fast, monthly), el rate limit del API y la frase histórica. Un tope de gasto (`spend limit`, `credit balance too low`) sigue fallando de inmediato: no se levanta solo por esperar.
- **El plazo de la tarea se comía la espera del límite.** `taskTimeoutMs` corría durante las horas que el run pasaba dormido y cancelaba la tarea a mitad de la espera. Ahora el reloj mide trabajo del agente: se para al empezar a esperar y se reanuda con el plazo que quedaba.
- Escribir o cerrar stdin de un proceso ya muerto podía subir como excepción no capturada (EPIPE).

### Added

- `RunOptions.onUsageLimitResume`: se dispara al terminar la espera, justo antes de reintentar.
- `Task.pauseTimeout()` / `Task.resumeTimeout()` / `Task.waitingMs`: control del reloj del timeout y tiempo acumulado dormido.
- `parseUsageLimitReset(text)`: extrae el momento de reset que anuncia el CLI. El aviso de Telegram ahora dice hasta cuándo espera ("Se restablece 3:30am (Europe/Madrid)").

## 0.2.1

### Added

- `ClaudeEffort`/`KnownClaudeEffort` y `OpenCodeEffort`/`KnownOpenCodeEffort`: reasoning effort tipado (autocomplete + string libre), igual que los modelos. `AnyEffort` para `BotConfig.defaults.effort`/`AskOptions.effort`.
- Niveles de effort de OpenCode ampliados con `xhigh` (verificado contra el schema `reasoningEffort` del binario instalado).

### Fixed

- `defaults.effort` solo se aplicaba al agente por defecto al arrancar; ahora aplica a `claude` y `opencode` por igual, como ya decía su propio doc-comment.
- `thinking: false` no tenía ningún efecto en Claude (solo apagaba el `--thinking` de OpenCode); ahora también filtra el bloque de razonamiento mostrado en Telegram para Claude.

## 0.2.0

### Added

- `autoMode`: auto mode real en `createBot`, sin botones ✅/❌ en Telegram — Claude corre con `--permission-mode bypassPermissions`, OpenCode con `autoApprove: true`.
- `bot.runStep(prompt, options?)`: como `bot.run()` pero devuelve una promesa awaitable, pensada para encadenar pasos en segundo plano con la misma sesión (`await bot.runStep('paso 1'); await bot.runStep('paso 2');`).
- Reintento automático ante límite de uso del plan: si Claude Code responde "usage limit reached", la librería lo detecta y reintenta sola cada `usageLimitRetryMs` (default 10 min) hasta que se restablece, sin bloquear el resto del bot; avisa una vez por Telegram al empezar a esperar. Cubre `ask()`, `run()`/`runStep()` y el chat interactivo.
- Alias de modelo de Claude Code ampliados (`fable`, `opusplan`, `best`, además de `opus`/`sonnet`/`haiku`).
- `CLAUDE.md` con guía de arquitectura para trabajar en el repo.

### Fixed

- `bot.run()` no continuaba la sesión de Claude entre tareas en segundo plano (cada una arrancaba sesión nueva); ahora lee y persiste `sessionId` igual que el chat interactivo.
- `bot.ask()` leía la sesión persistida pero nunca guardaba la resultante, así que no avanzaba entre llamadas.
- Los avisos automáticos de `bot.run()`/`bot.notify()` se enviaban sin `parse_mode: "HTML"`, mostrando el formato en crudo (asteriscos literales) en vez de negritas/código renderizados.

## 0.1.1

### Added

- `!comando`: ejecuta comandos de terminal en el directorio del proyecto y responde con su salida (cancelable vía `/cancel`, configurable con `shellEnabled`/`shellTimeoutMs`).
- Thinking 🧠: el razonamiento del agente llega en un mensaje expandible tras la respuesta (Claude `thinking` blocks, OpenCode `--thinking`); configurable con `createBot({ thinking })`.
- Rendering HTML: respuestas del agente y comandos con negritas, `<code>`, `<pre>` y enlaces reales (con fallback a texto plano).
- `/effort`: reasoning effort persistente por agente (`--effort` en Claude, `--variant` en OpenCode) con teclado inline.
- `/config`: muestra la configuración del bot con credenciales enmascaradas.

### Fixed

- Workflow de release: `npm@11` pineado por compatibilidad con Node 22.13.

## 0.1.0

Versión inicial del starter.

### Added

- Scaffold de librería TypeScript publicable (`@ariaskit/telegram2agent`).
- Build ESM con tsdown (dts + sourcemap) y versión inyectada en build time.
- `verify`: lint + typecheck + tests + build, atado a `prepublishOnly`.
- Release automático a npm con provenance OIDC desde GitHub Actions.
