import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  findMunicipioByCode,
  municipioLabel,
  searchMunicipios,
  type DaneMunicipio,
} from "@/lib/dane/municipios";

export const dynamic = "force-dynamic";

/** Techo duro: el buscador es para elegir, no para descargar el catálogo. */
const MAX_LIMIT = 15;

/**
 * Búsqueda del catálogo DIVIPOLA (DANE) de municipios de Colombia.
 *
 * POR QUÉ ES UN ENDPOINT Y NO UN IMPORT EN EL CLIENTE: el catálogo son
 * ~1.122 municipios (~100 KB). Mandárselo al navegador en cada carga de
 * la pantalla de ajustes es plata del operador en datos y peso de
 * bundle para un campo que se toca una vez en la vida. Acá filtramos en
 * el server y devolvemos un puñado.
 *
 *   GET ?q=envig      → hasta `limit` municipios que peguen
 *   GET ?code=05266   → resuelve un código (para hidratar el valor guardado)
 *
 * Autenticación: pedimos sesión iniciada, cualquiera. El contenido es
 * un catálogo público del DANE (no hay dato de ningún comercio acá), y
 * dejarlo abierto a cualquier sesión permite reusar el mismo endpoint
 * desde /operator, /group y /admin sin duplicar rutas.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const q = url.searchParams.get("q") ?? "";
  const limitParam = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.trunc(limitParam), MAX_LIMIT)
      : 8;

  // Resolver un código guardado → 0 o 1 resultado.
  if (code) {
    const m = findMunicipioByCode(code);
    return NextResponse.json({ results: m ? [serialize(m)] : [] });
  }

  return NextResponse.json({
    results: searchMunicipios(q, limit).map(serialize),
  });
}

function serialize(m: DaneMunicipio) {
  // `label` va armado desde el server para que el cliente no tenga que
  // repetir la regla de "Bogotá, D.C." (municipio == departamento).
  return { ...m, label: municipioLabel(m) };
}
