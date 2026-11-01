import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";

/**
 * Per-staff-role PWA manifest. When a mesero (or cocina / bar)
 * "adds to home screen" we want the icon labelled "MP MESERO" /
 * "MP COCINA" / "MP BAR" instead of the generic "MESAPAY" so a
 * device that runs multiple installed apps (e.g. tablet shared
 * across stations) doesn't get a row of identical icons.
 *
 * Why a route handler instead of `app/manifest.ts`: Next's
 * manifest file convention only supports a single root manifest.
 * For per-route manifests we serve them as plain route handlers
 * with `application/manifest+json` content-type and reference them
 * via `metadata.manifest` in the layout.
 *
 * Scope is locked to the role's section so the installed PWA can't
 * wander into customer pages — tapping a link out of `/mesero/*` in
 * standalone mode would otherwise open the browser, which is jarring.
 */

type Kind = "mesero" | "cocina" | "bar" | "comercial" | "asistencia" | "app";

type ManifestIcon = {
  src: string;
  sizes: string;
  type: string;
  purpose: "any" | "maskable";
};

type Variant = {
  name: string;
  shortName: string;
  start: string;
  scope: string;
  /**
   * Identidad propia (opcional). `id` hace que Chrome/Android traten la
   * variante como una app DISTINTA aunque comparta origen con MESAPAY; sin
   * `id`, dos manifests con el mismo start_url se pisan. Colores e iconos
   * propios permiten que la sección se vea como su propia app.
   */
  id?: string;
  description?: string;
  themeColor?: string;
  backgroundColor?: string;
  icons?: ManifestIcon[];
};

// Logo genérico MESAPAY: lo usan todas las variantes salvo las que traen
// iconos propios.
const GENERIC_ICONS: ManifestIcon[] = [
  {
    src: "/icons/icon-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "any",
  },
  {
    src: "/icons/icon-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "any",
  },
  {
    src: "/icons/icon-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  },
];

// Iconos exclusivos del CRM comercial ("MP CRM"): terracota con el glifo de
// pipeline de la barra inferior. Se generan con scripts/icons/crm-icon.mjs.
const CRM_ICONS: ManifestIcon[] = [
  {
    src: "/icons/crm-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "any",
  },
  {
    src: "/icons/crm-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "any",
  },
  {
    src: "/icons/crm-512-maskable.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  },
];

const DEFAULTS = {
  description: "MESAPAY · operación de restaurante",
  themeColor: "#0F0F0F",
  backgroundColor: "#F5EFE4",
  icons: GENERIC_ICONS,
} as const;

const VARIANTS: Record<Kind, Variant> = {
  // Manifest genérico del sitio (diners / landing). Antes vivía como
  // convención de archivo (src/app/manifest.ts), pero esa convención
  // inyecta su <link rel="manifest"> en TODAS las páginas — quedaban dos
  // manifests en /comercial, /mesero, etc. y iOS tomaba el primero (este),
  // instalando "MESAPAY → /" en vez de la app de la sección. Como variante
  // del route handler, el metadata.manifest de cada layout lo overridea
  // limpio y cada página queda con UN solo manifest.
  app: {
    name: "MESAPAY",
    shortName: "MESAPAY",
    start: "/",
    scope: "/",
  },
  mesero: {
    name: "MP MESERO",
    shortName: "MP MESERO",
    start: "/mesero/salon",
    scope: "/mesero/",
  },
  cocina: {
    name: "MP COCINA",
    shortName: "MP COCINA",
    start: "/cocina",
    scope: "/cocina",
  },
  bar: {
    name: "MP BAR",
    shortName: "MP BAR",
    start: "/bar",
    scope: "/bar",
  },
  // CRM comercial: app propia "MP CRM". La ruta sigue siendo
  // /api/manifest/comercial para no romper las instalaciones existentes
  // (que se llamaban "MP COMERCIAL"); al reinstalar toman el nombre e icono
  // nuevos. El scope abarca todo /comercial/ porque la barra inferior navega
  // a hoy / calendario / más — un scope más estrecho los abriría en el
  // navegador.
  comercial: {
    name: "MESAPAY CRM",
    shortName: "MP CRM",
    description: "MESAPAY · CRM comercial",
    id: "/comercial/crm",
    start: "/comercial/crm",
    scope: "/comercial/",
    themeColor: "#C4532B",
    backgroundColor: "#F5EFE4",
    icons: CRM_ICONS,
  },
  // Kiosko de asistencia (tablet en pared): el empleado puncha por
  // reconocimiento facial o eligiendo su nombre.
  asistencia: {
    name: "MP Asistencia",
    shortName: "MP Asistencia",
    start: "/operator/horarios/kiosko",
    scope: "/operator/horarios/kiosko",
  },
};

async function GETHandler(
  _req: Request,
  { params }: { params: Promise<{ kind: string }> },
) {
  const { kind } = await params;
  if (!(kind in VARIANTS)) {
    return NextResponse.json({ error: "unknown_kind" }, { status: 404 });
  }
  const v = VARIANTS[kind as Kind];

  // Cocina y bar son tableros (KDS) pensados para tablet en horizontal; el resto
  // (mesero, comercial, diner) son UIs de celular en vertical. NOTA: iOS/iPadOS
  // ignora `orientation` del manifest — ahí manda el bloqueo de rotación del
  // dispositivo. En Android sí se respeta (reinstalar la PWA para que aplique).
  const orientation =
    kind === "cocina" || kind === "bar" ? "landscape" : "portrait";

  const body = {
    ...(v.id ? { id: v.id } : {}),
    name: v.name,
    short_name: v.shortName,
    description: v.description ?? DEFAULTS.description,
    start_url: v.start,
    scope: v.scope,
    display: "standalone",
    orientation,
    background_color: v.backgroundColor ?? DEFAULTS.backgroundColor,
    theme_color: v.themeColor ?? DEFAULTS.themeColor,
    icons: v.icons ?? DEFAULTS.icons,
  };

  return new NextResponse(JSON.stringify(body), {
    headers: {
      "content-type": "application/manifest+json",
      "cache-control": "public, max-age=300",
    },
  });
}

export const GET = secureApi(GETHandler);
