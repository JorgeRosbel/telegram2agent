import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBot } from "@/index";

/**
 * `bot.resetSession()` corta la continuidad entre unidades de trabajo
 * independientes. Sin él, encadenar decenas de trabajos en una sola sesión la
 * hace crecer sin techo, porque cada paso reanuda todo el historial anterior.
 */

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function bootWithSession(): Promise<{
  bot: ReturnType<typeof createBot>;
  dbPath: string;
}> {
  dir = await mkdtemp(path.join(tmpdir(), "t2a-reset-"));
  const dbPath = path.join(dir, "state.json");
  await writeFile(
    dbPath,
    JSON.stringify({
      agent: "claude",
      models: { claude: "opus" },
      modes: {},
      efforts: { claude: "high" },
      sessions: { "42": { claude: "ses-vieja", opencode: "ses-oc" } },
    }),
    "utf8",
  );
  const bot = createBot({ token: "0:test-token", allow: [42], dbPath });
  // createBot carga el store de forma asíncrona; damos un turno al event loop.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { bot, dbPath };
}

describe("bot.resetSession", () => {
  it("olvida la sesión del agente activo y deja intacta la configuración", async () => {
    const { bot, dbPath } = await bootWithSession();

    await bot.resetSession();

    const state = JSON.parse(await readFile(dbPath, "utf8")) as {
      models: Record<string, string>;
      sessions: Record<string, Record<string, string>>;
    };
    expect(state.sessions["42"]?.claude).toBeUndefined();
    // Ni el otro agente ni el modelo persistido se tocan.
    expect(state.sessions["42"]?.opencode).toBe("ses-oc");
    expect(state.models.claude).toBe("opus");
  });

  it("puede apuntar a otro agente explícitamente", async () => {
    const { bot, dbPath } = await bootWithSession();

    await bot.resetSession({ agent: "opencode" });

    const state = JSON.parse(await readFile(dbPath, "utf8")) as {
      sessions: Record<string, Record<string, string>>;
    };
    expect(state.sessions["42"]?.opencode).toBeUndefined();
    expect(state.sessions["42"]?.claude).toBe("ses-vieja");
  });
});
