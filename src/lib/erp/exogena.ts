// Información exógena DIAN (medios magnéticos) — núcleo puro, port de
// zenith-erp. Incluye el dígito de verificación (módulo 11, obligatorio para
// los NIT en todos los formatos) y el generador del formato 1001 (pagos y
// abonos en cuenta a terceros) en TXT con separador punto y coma, valores
// sin separadores de miles — la convención de los medios magnéticos.

/* ───────────── Dígito de verificación (módulo 11, Res. DIAN) ─────────────
   Cada dígito del NIT, de derecha a izquierda, se multiplica por la serie de
   primos 3,7,13,17,19,23,29,37,41,43,47,53,59,67,71; la suma módulo 11 da el
   residuo; si residuo > 1, DV = 11 − residuo; si no, DV = residuo. */

const DV_PRIMES = [71, 67, 59, 53, 47, 43, 41, 37, 29, 23, 19, 17, 13, 7, 3];

/** DV módulo 11 de un NIT (solo dígitos, máx. 15). null si no es numérico. */
export function computeNitDv(nit: string): string | null {
  const digits = nit.replace(/\D/g, "");
  if (digits.length === 0 || digits.length > 15) return null;
  const padded = digits.padStart(15, "0");
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    sum += Number(padded[i]) * DV_PRIMES[i]!;
  }
  const remainder = sum % 11;
  return String(remainder > 1 ? 11 - remainder : remainder);
}

/** ¿El DV corresponde al NIT? (false si alguno es inválido). */
export function isValidNitDv(nit: string, dv: string): boolean {
  const computed = computeNitDv(nit);
  return computed !== null && computed === dv.trim();
}

/* ───────────────────── Formato 1001 — pagos a terceros ───────────────────── */

export type Formato1001Row = {
  /** Concepto DIAN (5004 = compras de bienes; 5002 honorarios; 5016 otros). */
  concepto: string;
  /** NIT/cédula solo dígitos. */
  nit: string;
  /** Razón social o nombre del tercero. */
  name: string;
  /** Pago o abono en cuenta (bruto, en PESOS enteros). */
  pagoPesos: number;
  /** Retención en la fuente practicada (pesos enteros). */
  retefuentePesos: number;
};

export type Formato1001Issue = {
  name: string;
  reason: "missing_nit" | "invalid_nit";
  pagoPesos: number;
};

/**
 * TXT del formato 1001: una fila por tercero-concepto con
 * concepto;tipoDoc;nit;dv;razón social;pago bruto;retefuente.
 * tipoDoc: 31 (NIT, ≥9 dígitos) o 13 (cédula). El contador ajusta/complementa
 * en el prevalidador de la DIAN — esto arma la base desde el libro.
 */
export function buildFormato1001Txt(rows: Formato1001Row[]): string {
  const lines = ["concepto;tipo_doc;nit;dv;razon_social;pago_abono;retefuente"];
  for (const r of rows) {
    const nit = r.nit.replace(/\D/g, "");
    const dv = computeNitDv(nit) ?? "";
    const tipoDoc = nit.length >= 9 ? "31" : "13";
    const name = r.name.replace(/[;\r\n]/g, " ").trim();
    lines.push(
      [
        r.concepto,
        tipoDoc,
        nit,
        dv,
        name,
        String(Math.round(r.pagoPesos)),
        String(Math.round(r.retefuentePesos)),
      ].join(";"),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
