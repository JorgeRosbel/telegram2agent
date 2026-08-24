declare const __PKG_VERSION__: string;

export const VERSION: string =
  typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "0.0.0-dev";
