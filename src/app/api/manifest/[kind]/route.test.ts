import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Manifests PWA por sección (/api/manifest/[kind]).
 *
 * Lo que blindan estos tests:
 *   1. La variante `comercial` es una app con identidad PROPIA ("MP CRM"):
 *      `id`, nombre, colores e iconos distintos del genérico MESAPAY, con la
 *      ruta /api/manifest/comercial intacta (instalaciones existentes).
 *   2. Los PNG que referencia existen en public/ y miden lo que declaran
 *      (un icono roto hace que Chrome no ofrezca instalar).
 *   3. Las demás variantes (mesero, app…) siguen con el logo genérico y sin
 *      `id`: la refactorización por variante no las tocó.
 */

// secureApi arrastra db/rateLimit; acá sólo interesa el handler.
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));

import { GET } from "./route";

type Icon = { src: string; sizes: string; type: string; purpose: string };
type Manifest = {
  id?: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: Icon[];
};

async function manifest(kind: string) {
  const res = await GET(new Request(`http://localhost/api/manifest/${kind}`), {
    params: Promise.resolve({ kind }),
  });
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: (await res.json()) as Manifest,
  };
}

const PUBLIC_DIR = path.join(process.cwd(), "public");

/** Ancho/alto del PNG leídos del chunk IHDR (sin dependencias). */
function pngSize(file: string) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function expectIconOnDisk(icon: Icon) {
  const file = path.join(PUBLIC_DIR, icon.src);
  expect(existsSync(file), `falta ${icon.src}`).toBe(true);
  const [w, h] = icon.sizes.split("x").map(Number);
  expect(pngSize(file)).toEqual({ width: w, height: h });
}

describe("/api/manifest/comercial — MP CRM", () => {
  it("tiene identidad propia: id, nombre corto, start/scope y colores terracota", async () => {
    const { status, contentType, body } = await manifest("comercial");
    expect(status).toBe(200);
    expect(contentType).toBe("application/manifest+json");
    expect(body.id).toBe("/comercial/crm");
    expect(body.name).toBe("MESAPAY CRM");
    expect(body.short_name).toBe("MP CRM");
    expect(body.description).toBe("MESAPAY · CRM comercial");
    expect(body.start_url).toBe("/comercial/crm");
    expect(body.scope).toBe("/comercial/");
    expect(body.display).toBe("standalone");
    expect(body.orientation).toBe("portrait");
    expect(body.theme_color).toBe("#C4532B");
    expect(body.background_color).toBe("#F5EFE4");
  });

  it("usa sólo iconos crm-* (any + maskable) y todos existen con el tamaño declarado", async () => {
    const { body } = await manifest("comercial");
    expect(body.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of body.icons) {
      expect(icon.src).toMatch(/^\/icons\/crm-/);
      expect(icon.type).toBe("image/png");
      expectIconOnDisk(icon);
    }
    expect(body.icons.map((i) => i.purpose)).toContain("maskable");
    expect(body.icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
    expect(body.icons.some((i) => i.sizes === "192x192" && i.purpose === "any")).toBe(true);
  });

  it("el apple-touch-icon del layout de /comercial existe y mide 180×180", () => {
    expectIconOnDisk({ src: "/icons/crm-180.png", sizes: "180x180", type: "image/png", purpose: "any" });
  });
});

describe("/api/manifest/[kind] — las demás variantes no cambian", () => {
  it("mesero sigue siendo MP MESERO con el logo genérico y sin id", async () => {
    const { status, body } = await manifest("mesero");
    expect(status).toBe(200);
    expect(body.id).toBeUndefined();
    expect(body.name).toBe("MP MESERO");
    expect(body.short_name).toBe("MP MESERO");
    expect(body.start_url).toBe("/mesero/salon");
    expect(body.scope).toBe("/mesero/");
    expect(body.description).toBe("MESAPAY · operación de restaurante");
    expect(body.theme_color).toBe("#0F0F0F");
    expect(body.background_color).toBe("#F5EFE4");
    expect(body.icons.map((i) => i.src)).toEqual([
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/icon-512.png",
    ]);
    for (const icon of body.icons) expectIconOnDisk(icon);
  });

  it("app (genérico) y cocina mantienen scope, orientación e iconos", async () => {
    const app = (await manifest("app")).body;
    expect(app.short_name).toBe("MESAPAY");
    expect(app.scope).toBe("/");
    expect(app.id).toBeUndefined();
    expect(app.icons[0].src).toBe("/icons/icon-192.png");

    const cocina = (await manifest("cocina")).body;
    expect(cocina.short_name).toBe("MP COCINA");
    expect(cocina.orientation).toBe("landscape");
    expect(cocina.icons[0].src).toBe("/icons/icon-192.png");
  });

  it("una variante desconocida responde 404", async () => {
    const { status } = await manifest("nope");
    expect(status).toBe(404);
  });
});
