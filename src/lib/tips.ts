// Propina del comensal — LÓGICA PURA, sin DB ni React.
//
// La misma aritmética la usan todas las superficies: el estado del pedido
// (que PREVISUALIZA el total con propina), el flujo de pago del comensal y
// el cobro del personal (que la COBRAN), los pagos mixtos, la precuenta y
// la factura emitida antes de cobrar (que la SUGIEREN). Si cada una
// redondeara o eligiera la base por su cuenta, el comensal vería un total
// acá y otro distinto al pagar o en el papel. Por eso el porcentaje
// sugerido, la base, el redondeo y la clave con la que se recuerda su
// elección viven en un solo lugar.
//
// ── Sobre qué valor se calcula el % ────────────────────────────────────
// Desde 2026-11 el % de propina se aplica sobre el valor a pagar ANTES DE
// IMPUESTOS (pedido del dueño: «la propina se calcula sobre el valor antes
// de impuestos»). Los precios de la carta llevan el impuesto ADENTRO (INC
// 8 % en un restaurante colombiano típico) y las líneas libres lo suman
// encima: una cuenta de $108.000 con INC 8 % tiene una base de $100.000 y
// la propina del 10 % es $10.000 (antes, $10.800).
//
// La parte sin impuesto de la cuenta la calcula el servidor con el MISMO
// reparto por línea que la factura electrónica (`tipBase.ts` →
// `dian/discountedLines.saleLines`) y viaja a las pantallas como un
// `TipBase` (lo cobrable y su parte sin impuesto). De cualquier parte de la
// cuenta —todo, partes iguales, lo de un comensal, un abono— la base es la
// PROPORCIÓN sin impuesto de lo que se paga (`tipBaseCentsOf`).
//
// La Ley 1935 de 2018 (art. 3, parágrafo 1) y la Circular Única de la SIC
// (Título II, Cap. 2, num. 2.4.1) topan la propina sugerida en «el 10% del
// valor del servicio prestado», sin decir si es con o sin impuestos.
// Sugerirla sobre el valor sin impuestos nunca supera ese tope.
//
// La política vive en `tipBasePolicyFor` para poder volverla configurable
// por país o comercio más adelante; hoy es una sola (todos los comercios
// son de Colombia). Las facturas emitidas ANTES de este cambio conservan
// la propina sugerida que imprimieron (ver `print/invoiceDoc.ts`).

/**
 * Porcentajes sugeridos. $0 queda para "sin propina"; 10 % es el default
 * social en Colombia ("la propina del 10") y el tope legal de la sugerida;
 * 15 / 20 cubren "el servicio fue muy bueno". Sobre la base SIN impuestos.
 */
export const TIP_OPTIONS = [0, 5, 10, 15, 20] as const;

/** Propina preseleccionada cuando el comensal todavía no eligió. */
export const DEFAULT_TIP_PCT = 10;

/**
 * Tope del control deslizante. Permite un valor personalizado por fuera de
 * los chips sin dejar que un dedo torpe deje una propina del 300 %. Se mide
 * contra la base sin impuestos, así que el 30 % es algo menos plata que
 * antes (30 % de $100.000 en vez de 30 % de $108.000). Los márgenes que se
 * derivan de él (`freeLineLimit`) quedan del lado seguro.
 */
export const MAX_TIP_PCT = 30;

/**
 * Sobre qué se calcula el %:
 *   · "pre_tax": el valor a pagar sin el impuesto (INC/IVA) embebido en la
 *     carta ni el que suman las líneas libres. La de hoy.
 *   · "with_tax": el valor a pagar tal cual, impuesto incluido. La de antes
 *     de 2026-11; queda para poder volver a ella por país o comercio.
 */
export type TipBasePolicy = "pre_tax" | "with_tax";

/**
 * EL punto de la política. Hoy es global ("pre_tax"): todos los comercios
 * son de Colombia. Para hacerla configurable, este es el único lugar que
 * hay que cambiar (y quien arma el `TipBase` ya le pasa el comercio).
 */
export function tipBasePolicyFor(place?: { country?: string | null } | null): TipBasePolicy {
  // `place` queda para la regla por país o comercio; hoy no cambia nada.
  void place;
  return "pre_tax";
}

/**
 * La cuenta (o la factura) partida en lo cobrable y su parte sin impuesto.
 * Es una RAZÓN: la base de la propina de cualquier monto se prorratea con
 * ella (`tipBaseCentsOf`). Lo arma el servidor (`tipBase.ts`) con el mismo
 * reparto por línea que la factura, y viaja tal cual a las pantallas.
 */
export type TipBase = Readonly<{
  /** Lo cobrable: comida con su impuesto y con el descuento ya restado, sin propina. */
  chargeableCents: number;
  /** Su parte sin impuesto. Igual a `chargeableCents` en una cuenta sin impuesto. */
  preTaxCents: number;
}>;

/**
 * La propina se redondea al PESO entero (100 centavos), mitad hacia arriba.
 * La base sin impuesto casi nunca da pesos redondos ($30.000 con INC 8 % →
 * $27.777,78) y COP no usa centavos: un cobro de $32.777,78 en el datáfono
 * terminaría en un «aprobado por otro monto» (Kushki ONE cobra pesos
 * enteros). Así lo que se ve, lo que se cobra y lo que imprime el papel son
 * el mismo número redondo.
 */
export const TIP_ROUNDING_CENTS = 100;

/** Redondeo mitad-arriba de num/den, entero y sin perder centavos (BigInt). */
function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator * BigInt(2) + denominator) / (denominator * BigInt(2));
}

const isCents = (v: number) => Number.isSafeInteger(v) && v > 0;

/**
 * Base de la propina de `amountCents` (lo que se paga de comida en este
 * cobro): su parte proporcional sin impuesto, redondeada al centavo. Sin
 * `base` (o una cuenta sin impuesto) la base es el monto tal cual. Nunca
 * supera el monto.
 */
export function tipBaseCentsOf(amountCents: number, base: TipBase | null | undefined): number {
  const amount = Math.round(amountCents);
  if (!isCents(amount)) return 0;
  if (!base || !isCents(Math.round(base.chargeableCents))) return amount;
  const chargeable = Math.round(base.chargeableCents);
  const preTax = Math.max(0, Math.round(base.preTaxCents));
  if (preTax >= chargeable) return amount;
  if (preTax === 0) return 0;
  const prorated = Number(roundedRatio(BigInt(amount) * BigInt(preTax), BigInt(chargeable)));
  return Math.min(amount, prorated);
}

/**
 * Propina de `pct` % sobre la base sin impuesto de `amountCents`, al peso
 * entero (`TIP_ROUNDING_CENTS`). LA función de la propina sugerida: el
 * estado del pedido, el cobro del comensal y del personal, los pagos
 * mixtos, la precuenta y la factura la calculan acá, así coinciden al
 * centavo.
 *
 * `base` null = sin datos de impuesto: la base es el monto (una cuenta sin
 * impuesto). Un `pct` ≤ 0 o un monto en cero no dan propina.
 */
export function tipCentsFor(amountCents: number, pct: number, base: TipBase | null | undefined): number {
  if (!(pct > 0) || !Number.isFinite(pct)) return 0;
  const tipBase = tipBaseCentsOf(amountCents, base);
  if (tipBase <= 0) return 0;
  // pct entero en la práctica (`clampTipPct`); con decimales se escala a
  // centésimas para no salir de la aritmética entera.
  const pctTimes100 = BigInt(Math.round(pct * 100));
  const unit = BigInt(TIP_ROUNDING_CENTS);
  const units = roundedRatio(BigInt(tipBase) * pctTimes100, BigInt(10_000) * unit);
  return Number(units * unit);
}

/** Monto + propina — lo que efectivamente sale del bolsillo del comensal. */
export function totalWithTip(amountCents: number, pct: number, base: TipBase | null | undefined): number {
  return amountCents + tipCentsFor(amountCents, pct, base);
}

/**
 * ¿Hay impuesto en la base? Las pantallas sólo aclaran «sobre el valor
 * antes de impuestos» cuando la base es menor que el monto: en una cuenta
 * sin impuesto la aclaración sobra.
 */
export function tipBaseExcludesTax(amountCents: number, base: TipBase | null | undefined): boolean {
  const amount = Math.round(amountCents);
  return isCents(amount) && tipBaseCentsOf(amount, base) < amount;
}

/**
 * Interpreta un porcentaje que llega de afuera (query `?tip=`, sessionStorage,
 * un input) y devuelve un ENTERO entre 0 y MAX_TIP_PCT, o null si no es un
 * número usable. Nunca inventa un valor: el que cae al default es el caller.
 */
export function parseTipPct(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return clampTipPct(n);
}

/** Entero acotado a 0..MAX_TIP_PCT. Un NaN cae a 0 — nunca a un tope. */
export function clampTipPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(MAX_TIP_PCT, Math.max(0, Math.round(pct)));
}

/**
 * Clave de sessionStorage donde se recuerda el % elegido POR CUENTA: una
 * mesa que paga dos cuentas seguidas no arrastra la propina de una a la
 * otra, y al cerrar la pestaña se olvida.
 */
export function tipStorageKey(orderId: string): string {
  return `mesapay.tip.${orderId}`;
}

/**
 * Agrega `?tip=<pct>` a un href (respetando un query string ya presente)
 * para que el flujo de pago arranque con la propina que el comensal
 * previsualizó en el estado del pedido.
 */
export function hrefWithTip(href: string, pct: number): string {
  const [path, hash = ""] = href.split("#", 2);
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}tip=${clampTipPct(pct)}${hash ? `#${hash}` : ""}`;
}
