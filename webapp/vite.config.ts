import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Build-stamped app version: single-sourced from this package.json so the
// GUI and the CLI read the same number.
import pkg from "./package.json";

// Strip the onnxruntime WASM binaries Vite picks up from the transformers.js
// package (~27 MB asyncify build). The runtime points wasmPaths at the
// jsDelivr CDN, so the emitted copies are dead weight.
function stripOrtWasm() {
  return {
    name: "strip-ort-wasm",
    generateBundle(_options: unknown, bundle: Record<string, { isAsset?: boolean; name?: string }>) {
      for (const key of Object.keys(bundle)) {
        if (/ort-.*\.wasm$/.test(key)) delete bundle[key];
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), stripOrtWasm()],
  define: {
    __APP_VERSION__: JSON.stringify(`v${pkg.version}`),
  },
  base: "/etiny/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname)],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
