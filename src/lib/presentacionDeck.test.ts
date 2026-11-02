import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La presentación pública (mesapay.co/presentacion) es un HTML estático en
 * public/presentacion/. Este test evita publicar una versión con capturas
 * rotas o con rutas relativas (la página se sirve sin barra final, así que
 * `shots/x.webp` resolvería a /shots/x.webp y no cargaría).
 */
const dir = join(process.cwd(), "public", "presentacion");
const html = readFileSync(join(dir, "index.html"), "utf8");

describe("presentación pública", () => {
  it("es un documento completo, en español, con título y vista previa para compartir", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="es">');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toContain('property="og:image" content="https://mesapay.co/presentacion/og.png"');
    expect(existsSync(join(dir, "og.png"))).toBe(true);
  });

  it("cada captura usa ruta absoluta y existe en public/presentacion/shots", () => {
    const srcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThanOrEqual(10);
    for (const src of srcs) {
      expect(src.startsWith("/presentacion/shots/"), src).toBe(true);
      expect(existsSync(join(process.cwd(), "public", src)), src).toBe(true);
    }
  });

  it("no queda nada propio del visor de artifacts", () => {
    expect(html).not.toContain("claude:");
  });
});
