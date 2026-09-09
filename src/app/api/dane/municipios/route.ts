import { NextResponse } from "next/server";
import { secureApi } from "@/lib/secureApi";
import {
  findMunicipioByCode,
  municipioLabel,
  searchMunicipios,
} from "@/lib/dane/municipios";

/** Catálogo público para altas sin sesión ni restaurante activo. Sin datos de comercios. */
export const GET = secureApi(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const code = params.get("code");
  const q = params.get("q") ?? "";
  if (q.length > 100 || (code && !/^\d{5}$/.test(code))) {
    return NextResponse.json({ results: [] }, { status: 400 });
  }
  const municipio = code ? findMunicipioByCode(code) : null;
  const results = code
    ? municipio
      ? [municipio]
      : []
    : searchMunicipios(q, 8);
  return NextResponse.json(
    { results: results.map((m) => ({ ...m, label: municipioLabel(m) })) },
    {
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" },
    },
  );
});
