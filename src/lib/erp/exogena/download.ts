/**
 * Registros oficiales de un formato a partir del reporte agregado, y su XML.
 * Lógica PURA: la ruta de descarga sólo carga el reporte, llama
 * `buildFormatoXml` (o `buildFormatoXlsx` en `excel.ts`) y arma la
 * respuesta HTTP.
 *
 * `buildFormatoRecords` es la ÚNICA fuente de los registros: el XML los
 * serializa con `xmlRecord` y el Excel de revisión los vuelca en columnas
 * con el mismo layout (`RECORD_LAYOUTS`), así ambos archivos llevan
 * exactamente los mismos registros, montos y omisiones.
 *
 * Reglas (Res. Única 000227/2025, T3):
 *  · el año del ENVÍO es el gravable + 1; FecInicial/FecFinal = el año;
 *  · con incidencias BLOQUEANTES en el formato no se produce XML
 *    (`issues_pending`): un XML parcial silencioso es peor que ninguno;
 *  · terceros sin documento reportable se omiten (defensa en profundidad:
 *    ya son incidencias bloqueantes) — quedan en `omitted` para el Excel;
 *  · cuantías menores: 1001 agrega por concepto los terceros con pagos
 *    acumulados < 3 UVT (salvo los sujetos a retención); 1008/1009 agregan
 *    los saldos < 12 UVT en un registro NIT 222222222 tipo 43;
 *  · montos en pesos enteros (`pesos`).
 */

import {
  CONCEPTO_1008_CLIENTES,
  CONCEPTO_1009_PROVEEDORES,
  tieneXml,
  umbralPagosCents,
  umbralSaldosCents,
  versionFormato,
  type FormatoConXml,
  type FormatoExogena,
} from "./normativa";
import {
  resolveTerceroDoc,
  type ExogenaReport,
  type IssueCode,
  type Tercero,
  type TerceroDoc,
} from "./sources";
import {
  buildCab,
  buildXml,
  CONSUMIDOR_FINAL_NID,
  CONSUMIDOR_FINAL_RAZ,
  CUANTIAS_MENORES_NID,
  CUANTIAS_MENORES_RAZ,
  CUANTIAS_MENORES_TDOC,
  dianFileName,
  dianIdType,
  encodePorcentajeBps,
  layoutRecord,
  PAIS_COLOMBIA,
  personAttrs,
  pesos,
  RECORD_LAYOUTS,
  xmlRecord,
  type RecordData,
} from "./xml";

export type XmlBuildResult =
  | { ok: true; filename: string; xml: string; records: number; valorTotal: number }
  | { ok: false; error: "issues_pending" | "no_xml" };

/**
 * Tercero que aporta a un registro, con el código de su incidencia (la misma
 * regla de `terceroIssues`): sirve para marcar en el Excel las filas que
 * tocan una incidencia del panel.
 */
export type RecordSource = { name: string; code: IssueCode | null };

export type FormatoRecord = {
  /** Atributos en el orden del layout del formato (lo que va al XML). */
  data: RecordData;
  /** Terceros agregados en el registro: uno, o varios en cuantías menores. */
  sources: RecordSource[];
};

export type FormatoRecords = {
  formato: FormatoConXml;
  /** Atributos del layout, en orden: columnas del Excel. */
  fields: readonly string[];
  /** Registros del XML, en su orden. */
  records: FormatoRecord[];
  /**
   * Filas que NO van al XML: terceros sin documento reportable. Cada una es
   * una incidencia bloqueante del formato, así que sólo hay omitidas cuando
   * el XML está bloqueado. El Excel las muestra al final, marcadas.
   */
  omitted: FormatoRecord[];
  /** ValorTotal de la cabecera, en pesos. */
  valorTotal: number;
};

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

/** Tercero sin documento reportable: lo que se sabe de él, para revisarlo. */
function omittedAttrs(t: Tercero): TerceroAttrs {
  return {
    tdoc: dianIdType(t.docType) ?? "",
    nid: (t.docNumber ?? "").trim(),
    dv: "",
    ...personAttrs({ kind: t.kind, name: t.name }),
    dir: t.dir,
    dpto: t.dpto,
    mun: t.mun,
    pais: t.pais,
  };
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

/** Código de incidencia del tercero (misma regla que el panel). */
function sourceOf(t: Tercero): RecordSource {
  if (t.key === "cf") return { name: t.name, code: null };
  const res = resolveTerceroDoc(t);
  return { name: t.name, code: res.issue ?? res.warning };
}

/**
 * Registros del formato, en el orden del XML, más las filas omitidas por
 * falta de documento. `uvtPesos` = UVT del año gravable (cuantías).
 */
export function buildFormatoRecords(
  report: ExogenaReport,
  formato: FormatoConXml,
  uvtPesos: number,
): FormatoRecords {
  const { fields } = RECORD_LAYOUTS[formato];
  const records: FormatoRecord[] = [];
  const omitted: FormatoRecord[] = [];
  let valorTotal = 0;

  const add = (d: RecordData, sources: RecordSource[]) =>
    records.push({ data: layoutRecord(fields, d), sources });
  /** Tercero sin documento: fuera del XML, con sus valores para el Excel. */
  const omit = (t: Tercero, d: RecordData) =>
    omitted.push({ data: layoutRecord(fields, { ...omittedAttrs(t), ...d }), sources: [sourceOf(t)] });

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
      const menores = new Map<
        string,
        { pago: number; ided: number; inded: number; retp: number; reta: number; sources: RecordSource[] }
      >();
      for (const r of rows) {
        const values = {
          pago: pesos(r.pagoCents),
          pnded: 0,
          ided: pesos(r.idedCents),
          inded: pesos(r.indedCents),
          retp: pesos(r.retpCents),
          reta: pesos(r.retaCents),
          comun: 0,
          ndom: 0,
        };
        const a = attrsOf(r.tercero);
        if (!a) {
          omit(r.tercero, { cpt: r.concept, ...values });
          continue;
        }
        valorTotal += values.pago;
        // Cuantías menores: pagos acumulados del TERCERO < 3 UVT, salvo los
        // sujetos a retención (se reportan siempre con el tercero).
        if ((totalByTercero.get(r.tercero.key) ?? 0) < umbral && !retained.has(r.tercero.key)) {
          const agg = menores.get(r.concept) ?? { pago: 0, ided: 0, inded: 0, retp: 0, reta: 0, sources: [] };
          agg.pago += r.pagoCents;
          agg.ided += r.idedCents;
          agg.inded += r.indedCents;
          agg.retp += r.retpCents;
          agg.reta += r.retaCents;
          agg.sources.push(sourceOf(r.tercero));
          menores.set(r.concept, agg);
          continue;
        }
        add({ cpt: r.concept, ...a, ...values }, [sourceOf(r.tercero)]);
      }
      for (const [cpt, agg] of menores) {
        add(
          {
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
          },
          agg.sources,
        );
      }
      break;
    }

    case "1005": {
      for (const r of report.formats["1005"]) {
        const values = { vimp: pesos(r.vimpCents), ivade: pesos(r.ivadeCents) };
        const a = attrsOf(r.tercero);
        if (!a) {
          omit(r.tercero, values);
          continue;
        }
        valorTotal += values.vimp;
        add({ ...a, ...values }, [sourceOf(r.tercero)]);
      }
      break;
    }

    case "1006": {
      for (const r of report.formats["1006"]) {
        const values = { imp: pesos(r.ivaCents), iva: pesos(r.ivaDevCents), icon: pesos(r.incCents) };
        const a = attrsOf(r.tercero);
        if (!a) {
          omit(r.tercero, values);
          continue;
        }
        valorTotal += values.imp + values.icon;
        add({ ...a, ...values }, [sourceOf(r.tercero)]);
      }
      break;
    }

    case "1007": {
      for (const r of report.formats["1007"]) {
        const values = { cpt: r.concept, ibru: pesos(r.ibruCents), dred: pesos(r.dredCents) };
        const a = attrsOf(r.tercero);
        if (!a) {
          omit(r.tercero, values);
          continue;
        }
        valorTotal += values.ibru;
        add({ ...a, ...values }, [sourceOf(r.tercero)]);
      }
      break;
    }

    case "1008":
    case "1009": {
      const cpt = formato === "1008" ? CONCEPTO_1008_CLIENTES : CONCEPTO_1009_PROVEEDORES;
      const umbral = umbralSaldosCents(uvtPesos);
      let menores = 0;
      const menoresSources: RecordSource[] = [];
      for (const r of report.formats[formato]) {
        const a = attrsOf(r.tercero);
        if (!a) {
          omit(r.tercero, { cpt, sal: pesos(r.saldoCents) });
          continue;
        }
        valorTotal += pesos(r.saldoCents);
        // Saldos < 12 UVT se agregan como cuantías menores.
        if (r.saldoCents < umbral) {
          menores += r.saldoCents;
          menoresSources.push(sourceOf(r.tercero));
          continue;
        }
        add({ cpt, ...a, sal: pesos(r.saldoCents) }, [sourceOf(r.tercero)]);
      }
      if (menores > 0) {
        add({ cpt, ...cuantiasMenoresAttrs(), sal: pesos(menores) }, menoresSources);
      }
      break;
    }

    case "1010": {
      for (const r of report.formats["1010"]) {
        const { por, dec } = encodePorcentajeBps(r.sharePctBps);
        const values = { valnom: pesos(r.nominalCents), valprm: pesos(r.premiumCents), por, dec };
        const a = attrsOf(r.tercero);
        if (!a) {
          omit(r.tercero, values);
          continue;
        }
        valorTotal += values.valnom + values.valprm;
        add({ ...a, ...values }, [sourceOf(r.tercero)]);
      }
      break;
    }

    case "1011": {
      for (const r of report.formats["1011"]) {
        // Sin concepto del anexo no va al archivo (aviso, no bloquea).
        if (!r.concept) continue;
        valorTotal += pesos(r.valueCents);
        add({ cpt: r.concept, sal: pesos(r.valueCents) }, [{ name: r.form, code: null }]);
      }
      break;
    }

    case "1012": {
      for (const r of report.formats["1012"]) {
        const values = { cpt: r.concept, val: pesos(r.valueCents) };
        const a = attrsOf(r.tercero);
        if (!a) {
          omit(r.tercero, values);
          continue;
        }
        valorTotal += values.val;
        add({ ...a, ...values }, [sourceOf(r.tercero)]);
      }
      break;
    }
  }

  return { formato, fields, records, omitted, valorTotal };
}

/** ¿El formato tiene incidencias que bloquean su XML? */
export function formatoBloqueado(report: ExogenaReport, formato: FormatoExogena): boolean {
  return report.issues.some((i) => i.format === formato && i.blocking);
}

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
  if (!tieneXml(formato)) return { ok: false, error: "no_xml" };
  if (formatoBloqueado(report, formato)) return { ok: false, error: "issues_pending" };

  const { records, valorTotal } = buildFormatoRecords(report, formato, uvtPesos);
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
    xml: buildXml(cab, records.map((r) => xmlRecord(formato, r.data))),
    records: records.length,
    valorTotal,
  };
}
