import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: true,
  sourcemap: true,
  // TypeScript 7 is validated by the separate typecheck; rollup-plugin-dts still embeds TS 5.x.
  dts: false,
  clean: true,
  noExternal: [/^@wuyan\//]
});
