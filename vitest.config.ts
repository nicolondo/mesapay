import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Los tests de este feature son de funciones puras (sin DB, sin red).
    globals: false,
  },
});
