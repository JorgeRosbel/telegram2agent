import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const { version } = createRequire(import.meta.url)("./package.json") as {
  version: string;
};

export default defineConfig({
  define: { __PKG_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
