# Changelog

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
