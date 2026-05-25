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

type Kind = "mesero" | "cocina" | "bar";

const VARIANTS: Record<
  Kind,
  { name: string; shortName: string; start: string; scope: string }
> = {
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
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ kind: string }> },
) {
  const { kind } = await params;
  if (!(kind in VARIANTS)) {
    return NextResponse.json({ error: "unknown_kind" }, { status: 404 });
  }
  const v = VARIANTS[kind as Kind];

  const body = {
    name: v.name,
    short_name: v.shortName,
    description: "MESAPAY · operación de restaurante",
    start_url: v.start,
    scope: v.scope,
    display: "standalone",
    orientation: "portrait",
    background_color: "#F5EFE4",
    theme_color: "#0F0F0F",
    icons: [
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
    ],
  };

  return new NextResponse(JSON.stringify(body), {
    headers: {
      "content-type": "application/manifest+json",
      "cache-control": "public, max-age=300",
    },
  });
}
