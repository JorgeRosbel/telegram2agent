# Changelog

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
