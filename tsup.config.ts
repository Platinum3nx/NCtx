import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts"
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  noExternal: [/.*/],
  banner: {
    js: `import { createRequire as __nctx_createRequire } from "node:module"; import { fileURLToPath as __nctx_fileURLToPath } from "node:url"; const require = __nctx_createRequire(__nctx_fileURLToPath(import.meta.url));`
  }
});
