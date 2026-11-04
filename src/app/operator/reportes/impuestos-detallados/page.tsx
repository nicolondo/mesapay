import { redirect } from "next/navigation";
import { firstParam } from "../_components/gate";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * «Impuestos detallados» quedó dentro de «Impuestos del período»: los
 * auxiliares de cada renglón (documento por documento, comprobante por
 * comprobante) y su Excel/CSV cubren lo que mostraba esta página. Los
 * enlaces viejos (marcadores, la ayuda, correos) caen en el mismo período.
 * La API `taxes-detail` sigue respondiendo igual para quien la use.
 */
export default async function ImpuestosDetalladosPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const keep = new URLSearchParams();
  for (const k of ["desde", "hasta", "anio"] as const) {
    const v = firstParam(sp[k]);
    if (v && /^[\d-]{4,10}$/.test(v)) keep.set(k, v);
  }
  const qs = keep.toString();
  redirect(`/operator/reportes/impuestos${qs ? `?${qs}` : ""}`);
}
