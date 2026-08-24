import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  {
    files: ["**/*.{js,ts,mjs}"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
  },
);
