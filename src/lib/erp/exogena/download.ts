/**
 * XML oficial de un formato a partir del reporte agregado. Lógica PURA:
 * la ruta de descarga sólo carga el reporte, llama `buildFormatoXml` y
 * arma la respuesta HTTP.
 *
 * Reglas (Res. Única 000227/2025, T3):
 *  · el año del ENVÍO es el gravable + 1; FecInicial/FecFinal = el año;
 *  · con incidencias BLOQUEANTES en el formato no se produce archivo
 *    (`issues_pending`): un XML parcial silencioso es peor que ninguno;
 *  · terceros sin documento reportable se omiten (defensa en profundidad:
 *    ya son incidencias bloqueantes);
 *  · cuantías menores: 1001 agrega por concepto los terceros con pagos
 *    acumulados < 3 UVT (salvo los sujetos a retención); 1008/1009 agregan
 *    los saldos < 12 UVT en un registro NIT 222222222 tipo 43;
 *  · montos en pesos enteros (`pesos`).
 */

import {
  CONCEPTO_1008_CLIENTES,
  CONCEPTO_1009_PROVEEDORES,
  umbralPagosCents,
  umbralSaldosCents,
  versionFormato,
  type FormatoExogena,
} from "./normativa";
import { resolveTerceroDoc, type ExogenaReport, type Tercero, type TerceroDoc } from "./sources";
import {
  buildCab,
  buildXml,
  CONSUMIDOR_FINAL_NID,
  CONSUMIDOR_FINAL_RAZ,
  CUANTIAS_MENORES_NID,
  CUANTIAS_MENORES_RAZ,
  CUANTIAS_MENORES_TDOC,
  dianFileName,
  encodePorcentajeBps,
  PAIS_COLOMBIA,
  personAttrs,
  pesos,
  rec1001,
  rec1005,
  rec1006,
  rec1007,
  rec1010,
  rec1011,
  rec1012,
  recSaldo,
  type RecordData,
} from "./xml";

export type XmlBuildResult =
  | { ok: true; filename: string; xml: string; records: number; valorTotal: number }
  | { ok: false; error: "issues_pending" | "no_xml" };

type TerceroAttrs = Record<string, string>;

/** Atributos de identificación + nombre + ubicación de un tercero. */
function terceroAttrs(t: Tercero, doc: TerceroDoc): TerceroAttrs {
  return {
    ...doc,
    ...personAttrs({ kind: t.kind, name: t.name }),
    dir: t.dir,
    dpto: t.dpto,
    mun: t.mun,
    pais: t.pais,
  };
}

/** Documento del tercero, o el consumidor final para la clave "cf". */
function docOf(t: Tercero): TerceroDoc | null {
  if (t.key === "cf") return { tdoc: CUANTIAS_MENORES_TDOC, nid: CONSUMIDOR_FINAL_NID, dv: "" };
  return resolveTerceroDoc(t).doc;
}

function consumidorFinalAttrs(): TerceroAttrs {
  return {
    tdoc: CUANTIAS_MENORES_TDOC,
    nid: CONSUMIDOR_FINAL_NID,
    dv: "",
    apl1: "",
    apl2: "",
    nom1: "",
    nom2: "",
    raz: CONSUMIDOR_FINAL_RAZ,
    dir: "",
    dpto: "0",
    mun: "0",
    pais: PAIS_COLOMBIA,
  };
}

function attrsOf(t: Tercero): TerceroAttrs | null {
  if (t.key === "cf") return consumidorFinalAttrs();
  const doc = docOf(t);
  return doc ? terceroAttrs(t, doc) : null;
}

const cuantiasMenoresAttrs = (): TerceroAttrs => ({
  tdoc: CUANTIAS_MENORES_TDOC,
  nid: CUANTIAS_MENORES_NID,
  dv: "",
  apl1: "",
  apl2: "",
  nom1: "",
  nom2: "",
  raz: CUANTIAS_MENORES_RAZ,
  dir: "",
  dpto: "0",
  mun: "0",
  pais: PAIS_COLOMBIA,
});

/**
 * Arma el XML del formato. `uvtPesos` = UVT del año gravable (cuantías).
 * `fecEnvio` sólo para tests deterministas.
 */
export function buildFormatoXml(
  report: ExogenaReport,
  formato: FormatoExogena,
  year: number,
  uvtPesos: number,
  opts: { fecEnvio?: string } = {},
): XmlBuildResult {
  if (formato === "2276") return { ok: false, error: "no_xml" };
  if (report.issues.some((i) => i.format === formato && i.blocking)) {
    return { ok: false, error: "issues_pending" };
  }

  const records: string[] = [];
  let valorTotal = 0;

  switch (formato) {
    case "1001": {
      const rows = report.formats["1001"];
      const umbral = umbralPagosCents(uvtPesos);
      const totalByTercero = new Map<string, number>();
      const retained = new Set<string>();
      for (const r of rows) {
        totalByTercero.set(r.tercero.key, (totalByTercero.get(r.tercero.key) ?? 0) + r.pagoCents);
        if (r.retpCents > 0 || r.retaCents > 0) retained.add(r.tercero.key);
      }
      const menores = new Map<string, { pago: number; ided: number; inded: number; retp: number; reta: number }>();
      for (const r of rows) {
        const a = attrsOf(r.tercero);
        if (!a) continue;
        valorTotal += pesos(r.pagoCents);
        // Cuantías menores: pagos acumulados del TERCERO < 3 UVT, salvo los
        // sujetos a retención (se reportan siempre con el tercero).
        if ((totalByTercero.get(r.tercero.key) ?? 0) < umbral && !retained.has(r.tercero.key)) {
          const agg = menores.get(r.concept) ?? { pago: 0, ided: 0, inded: 0, retp: 0, reta: 0 };
          agg.pago += r.pagoCents;
          agg.ided += r.idedCents;
          agg.inded += r.indedCents;
          agg.retp += r.retpCents;
          agg.reta += r.retaCents;
          menores.set(r.concept, agg);
          continue;
        }
        records.push(
          rec1001({
            cpt: r.concept,
            ...a,
            pago: pesos(r.pagoCents),
            pnded: 0,
            ided: pesos(r.idedCents),
            inded: pesos(r.indedCents),
            retp: pesos(r.retpCents),
            reta: pesos(r.retaCents),
            comun: 0,
            ndom: 0,
          }),
        );
      }
      for (const [cpt, agg] of menores) {
        records.push(
          rec1001({
            cpt,
            ...cuantiasMenoresAttrs(),
            pago: pesos(agg.pago),
            pnded: 0,
            ided: pesos(agg.ided),
            inded: pesos(agg.inded),
            retp: pesos(agg.retp),
            reta: pesos(agg.reta),
            comun: 0,
            ndom: 0,
          }),
        );
      }
      break;
    }

    case "1005": {
      for (const r of report.formats["1005"]) {
        const a = attrsOf(r.tercero);
        if (!a) continue;
        valorTotal += pesos(r.vimpCents);
        records.push(rec1005({ ...a, vimp: pesos(r.vimpCents), ivade: pesos(r.ivadeCents) }));
      }
      break;
    }

    case "1006": {
      for (const r of report.formats["1006"]) {
        const a = attrsOf(r.tercero);
        if (!a) continue;
        valorTotal += pesos(r.ivaCents) + pesos(r.incCents);
        records.push(
          rec1006({ ...a, imp: pesos(r.ivaCents), iva: pesos(r.ivaDevCents), icon: pesos(r.incCents) }),
        );
      }
      break;
    }

    case "1007": {
      for (const r of report.formats["1007"]) {
        const a = attrsOf(r.tercero);
        if (!a) continue;
        valorTotal += pesos(r.ibruCents);
        records.push(
          rec1007({ cpt: r.concept, ...a, ibru: pesos(r.ibruCents), dred: pesos(r.dredCents) }),
        );
      }
      break;
    }

    case "1008":
    case "1009": {
      const esCxc = formato === "1008";
      const element = esCxc ? "saldoscc" : "saldoscp";
      const cpt = esCxc ? CONCEPTO_1008_CLIENTES : CONCEPTO_1009_PROVEEDORES;
      const umbral = umbralSaldosCents(uvtPesos);
      let menores = 0;
      for (const r of report.formats[formato]) {
        const a = attrsOf(r.tercero);
        if (!a) continue;
        valorTotal += pesos(r.saldoCents);
        // Saldos < 12 UVT se agregan como cuantías menores.
        if (r.saldoCents < umbral) {
          menores += r.saldoCents;
          continue;
        }
        records.push(recSaldo(element, { cpt, ...a, sal: pesos(r.saldoCents) }));
      }
      if (menores > 0) {
        records.push(recSaldo(element, { cpt, ...cuantiasMenoresAttrs(), sal: pesos(menores) }));
      }
      break;
    }

    case "1010": {
      for (const r of report.formats["1010"]) {
        const a = attrsOf(r.tercero);
        if (!a) continue;
        const { por, dec } = encodePorcentajeBps(r.sharePctBps);
        valorTotal += pesos(r.nominalCents) + pesos(r.premiumCents);
        records.push(
          rec1010({
            ...a,
            valnom: pesos(r.nominalCents),
            valprm: pesos(r.premiumCents),
            por,
            dec,
          }),
        );
      }
      break;
    }

    case "1011": {
      for (const r of report.formats["1011"]) {
        if (!r.concept) continue;
        valorTotal += pesos(r.valueCents);
        records.push(rec1011({ cpt: r.concept, sal: pesos(r.valueCents) }));
      }
      break;
    }

    case "1012": {
      for (const r of report.formats["1012"]) {
        const a = attrsOf(r.tercero);
        if (!a) continue;
        valorTotal += pesos(r.valueCents);
        const d: RecordData = { cpt: r.concept, ...a, val: pesos(r.valueCents) };
        records.push(rec1012(d));
      }
      break;
    }
  }

  const version = versionFormato(formato, year);
  const cab = buildCab({
    formato: Number(formato),
    version,
    anoEnvio: year + 1,
    fecInicial: `${year}-01-01`,
    fecFinal: `${year}-12-31`,
    valorTotal,
    cantReg: records.length,
    fecEnvio: opts.fecEnvio,
  });
  return {
    ok: true,
    filename: dianFileName(formato, version, year),
    xml: buildXml(cab, records),
    records: records.length,
    valorTotal,
  };
}
