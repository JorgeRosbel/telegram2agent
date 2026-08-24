import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "tsdown";

const { version } = createRequire(import.meta.url)("./package.json") as {
  version: string;
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  define: { __PKG_VERSION__: JSON.stringify(version) },
  alias: {
    "@": path.resolve(import.meta.dirname, "src"),
  },
});
