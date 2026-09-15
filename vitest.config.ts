import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Ver src/test/stubs/server-only.ts.
      "server-only": path.resolve(__dirname, "./src/test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Los tests de este feature son de funciones puras (sin DB, sin red).
    globals: false,
  },
});
