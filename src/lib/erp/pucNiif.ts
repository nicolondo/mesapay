// Plan de cuentas base — NIIF para PYMES (Grupo 2), estructura tipo PUC
// (clase/grupo/cuenta/subcuenta) que es la que importa el software contable
// colombiano. Catálogo CURADO para un restaurante; el contador puede extender.
//
// La jerarquía se deriva de la longitud del código: 1=clase, 2=grupo,
// 4=cuenta, 6=subcuenta. Sólo las subcuentas (postable) reciben movimientos.
//
// NOTA: alineado al estándar, pero el mapeo específico lo debe validar el
// contador del comercio antes de usarlo en una declaración real.

export type PucType =
  | "activo"
  | "pasivo"
  | "patrimonio"
  | "ingreso"
  | "gasto"
  | "costo";
export type PucNature = "debito" | "credito";

export type PucSeedRow = {
  code: string;
  name: string;
  type: PucType;
  /** Naturaleza. Casi siempre se deriva del tipo, pero hay contra-cuentas
   *  (depreciación, devoluciones, pérdida) que invierten — por eso explícita. */
  nature: PucNature;
  /** true = subcuenta hoja donde se registran movimientos. */
  postable?: boolean;
};

// Helper: marca postable las hojas. Sólo se ponen postable las subcuentas de
// 6 dígitos; las agrupadoras (1/2/4) nunca reciben movimientos.
const P = (
  code: string,
  name: string,
  type: PucType,
  nature: PucNature,
): PucSeedRow => ({ code, name, type, nature, postable: code.length === 6 });

export const PUC_NIIF_G2: PucSeedRow[] = [
  // ───────────────────────── CLASE 1 · ACTIVO ─────────────────────────
  P("1", "Activo", "activo", "debito"),
  P("11", "Efectivo y equivalentes al efectivo", "activo", "debito"),
  P("1105", "Caja", "activo", "debito"),
  P("110505", "Caja general", "activo", "debito"),
  P("1110", "Bancos", "activo", "debito"),
  P("111005", "Cuenta corriente / ahorros", "activo", "debito"),
  P("1120", "Cuentas de pasarela de pago", "activo", "debito"),
  P("112005", "Saldo en pasarela (Kushki)", "activo", "debito"),
  P("13", "Deudores comerciales y otras cuentas por cobrar", "activo", "debito"),
  P("1305", "Clientes", "activo", "debito"),
  P("130505", "Clientes nacionales", "activo", "debito"),
  P("1330", "Anticipos y avances", "activo", "debito"),
  P("133005", "A proveedores", "activo", "debito"),
  P("1355", "Anticipo de impuestos y contribuciones", "activo", "debito"),
  P("135515", "Retención en la fuente", "activo", "debito"),
  P("135517", "Impuesto a las ventas retenido (reteIVA)", "activo", "debito"),
  P("135518", "Impuesto de industria y comercio retenido (reteICA)", "activo", "debito"),
  P("14", "Inventarios", "activo", "debito"),
  P("1435", "Mercancías no fabricadas por la empresa", "activo", "debito"),
  P("143505", "Insumos y materia prima", "activo", "debito"),
  P("15", "Propiedades, planta y equipo", "activo", "debito"),
  P("1524", "Equipo de oficina", "activo", "debito"),
  P("152405", "Equipos y enseres", "activo", "debito"),
  P("1540", "Flota y equipo de transporte", "activo", "debito"),
  P("154005", "Vehículos", "activo", "debito"),
  P("1592", "Depreciación acumulada", "activo", "credito"),
  P("159205", "Depreciación acumulada", "activo", "credito"),

  // ───────────────────────── CLASE 2 · PASIVO ─────────────────────────
  P("2", "Pasivo", "pasivo", "credito"),
  P("22", "Proveedores", "pasivo", "credito"),
  P("2205", "Nacionales", "pasivo", "credito"),
  P("220505", "Proveedores nacionales", "pasivo", "credito"),
  P("23", "Cuentas por pagar", "pasivo", "credito"),
  P("2335", "Costos y gastos por pagar", "pasivo", "credito"),
  P("233505", "Costos y gastos por pagar", "pasivo", "credito"),
  P("2365", "Retención en la fuente", "pasivo", "credito"),
  P("236505", "Retención en la fuente por pagar", "pasivo", "credito"),
  P("2367", "Impuesto a las ventas retenido", "pasivo", "credito"),
  P("236705", "ReteIVA por pagar", "pasivo", "credito"),
  P("2368", "Impuesto de industria y comercio retenido", "pasivo", "credito"),
  P("236805", "ReteICA por pagar", "pasivo", "credito"),
  P("2370", "Retenciones y aportes de nómina", "pasivo", "credito"),
  P("237005", "Aportes y retenciones de nómina", "pasivo", "credito"),
  P("24", "Impuestos, gravámenes y tasas", "pasivo", "credito"),
  P("2408", "Impuesto sobre las ventas por pagar (IVA)", "pasivo", "credito"),
  P("240805", "IVA por pagar", "pasivo", "credito"),
  P("2412", "Impuesto nacional al consumo por pagar (INC)", "pasivo", "credito"),
  P("241205", "INC por pagar", "pasivo", "credito"),
  P("25", "Obligaciones laborales", "pasivo", "credito"),
  P("2505", "Salarios por pagar", "pasivo", "credito"),
  P("250505", "Salarios por pagar", "pasivo", "credito"),
  P("2510", "Cesantías consolidadas", "pasivo", "credito"),
  P("251005", "Cesantías por pagar", "pasivo", "credito"),
  P("2520", "Prima de servicios", "pasivo", "credito"),
  P("252005", "Prima por pagar", "pasivo", "credito"),
  P("2525", "Vacaciones consolidadas", "pasivo", "credito"),
  P("252505", "Vacaciones por pagar", "pasivo", "credito"),
  P("28", "Otros pasivos", "pasivo", "credito"),
  P("2805", "Anticipos y avances recibidos", "pasivo", "credito"),
  P("280505", "Depósitos / abonos de reserva", "pasivo", "credito"),

  // ─────────────────────── CLASE 3 · PATRIMONIO ───────────────────────
  P("3", "Patrimonio", "patrimonio", "credito"),
  P("31", "Capital social", "patrimonio", "credito"),
  P("3115", "Aportes sociales", "patrimonio", "credito"),
  P("311505", "Capital / aportes", "patrimonio", "credito"),
  P("36", "Resultados del ejercicio", "patrimonio", "credito"),
  P("3605", "Utilidad del ejercicio", "patrimonio", "credito"),
  P("360505", "Utilidad del ejercicio", "patrimonio", "credito"),
  P("3610", "Pérdida del ejercicio", "patrimonio", "debito"),
  P("361005", "Pérdida del ejercicio", "patrimonio", "debito"),
  P("37", "Resultados de ejercicios anteriores", "patrimonio", "credito"),
  P("3705", "Utilidades acumuladas", "patrimonio", "credito"),
  P("370505", "Resultados acumulados", "patrimonio", "credito"),

  // ──────────────────────── CLASE 4 · INGRESOS ────────────────────────
  P("4", "Ingresos", "ingreso", "credito"),
  P("41", "Operacionales", "ingreso", "credito"),
  P("4135", "Comercio al por mayor y al por menor", "ingreso", "credito"),
  P("413505", "Venta de alimentos", "ingreso", "credito"),
  P("413510", "Venta de bebidas", "ingreso", "credito"),
  P("4175", "Devoluciones en ventas", "ingreso", "debito"),
  P("417505", "Devoluciones en ventas", "ingreso", "debito"),
  P("42", "No operacionales", "ingreso", "credito"),
  P("4210", "Financieros", "ingreso", "credito"),
  P("421005", "Ingresos financieros", "ingreso", "credito"),
  P("4295", "Diversos", "ingreso", "credito"),
  P("429505", "Ingresos diversos", "ingreso", "credito"),

  // ───────────────────────── CLASE 5 · GASTOS ─────────────────────────
  P("5", "Gastos", "gasto", "debito"),
  P("51", "Operacionales de administración", "gasto", "debito"),
  P("5105", "Gastos de personal", "gasto", "debito"),
  P("510506", "Sueldos", "gasto", "debito"),
  P("510527", "Aportes y prestaciones", "gasto", "debito"),
  P("5110", "Honorarios", "gasto", "debito"),
  P("511005", "Honorarios", "gasto", "debito"),
  P("5120", "Arrendamientos", "gasto", "debito"),
  P("512010", "Arrendamiento local", "gasto", "debito"),
  P("5135", "Servicios", "gasto", "debito"),
  P("513505", "Servicios públicos", "gasto", "debito"),
  P("513535", "Teléfono e internet", "gasto", "debito"),
  P("5145", "Mantenimiento y reparaciones", "gasto", "debito"),
  P("514505", "Mantenimiento", "gasto", "debito"),
  P("5195", "Diversos", "gasto", "debito"),
  P("519505", "Gastos diversos", "gasto", "debito"),
  P("52", "Operacionales de ventas", "gasto", "debito"),
  P("5245", "Comisiones", "gasto", "debito"),
  P("524505", "Comisiones de pasarela / tarjetas", "gasto", "debito"),
  P("5295", "Diversos", "gasto", "debito"),
  P("529505", "Gastos de ventas diversos", "gasto", "debito"),
  P("53", "No operacionales", "gasto", "debito"),
  P("5305", "Financieros", "gasto", "debito"),
  P("530505", "Gastos bancarios", "gasto", "debito"),
  P("530595", "Otros gastos financieros", "gasto", "debito"),

  // ─────────────────────── CLASE 6 · COSTO DE VENTAS ──────────────────
  P("6", "Costos de ventas", "costo", "debito"),
  P("61", "Costo de ventas", "costo", "debito"),
  P("6135", "Comercio al por mayor y al por menor", "costo", "debito"),
  P("613505", "Costo de alimentos y bebidas", "costo", "debito"),
];

/** Nivel jerárquico por longitud de código PUC (1/2/4/6). */
export function pucLevel(code: string): number {
  return code.length; // 1, 2, 4 o 6 — coincide con clase/grupo/cuenta/subcuenta
}

/** Código de la cuenta padre (prefijo), o null para las clases (1 dígito). */
export function pucParentCode(code: string): string | null {
  if (code.length <= 1) return null;
  if (code.length === 2) return code.slice(0, 1);
  if (code.length === 4) return code.slice(0, 2);
  return code.slice(0, 4); // 6 → 4
}
