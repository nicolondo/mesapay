// Códigos PUC contra los que escribe el motor contable: los asientos-resumen
// por día y por mes (posting.ts), el cierre del ejercicio (fiscal.ts), la
// conciliación bancaria y el registro de declaraciones. Viven acá,
// compartidos, para que el plan de cuentas (chart.ts) sepa cuáles NO se
// pueden desactivar: si una de estas falta o queda inactiva, el asiento que
// la necesita se omite entero.
//
// Si el motor empieza a usar un código nuevo, agregalo ACÁ y usalo como
// `ENGINE.X` — nunca un literal suelto en posting.ts.
import { IVA_DESCONTABLE_CODE } from "./pucNiif";

export const ENGINE = {
  /** Caja general (efectivo). */
  CAJA: "110505",
  /** Bancos: datáfono propio, transferencias, pago de impuestos. */
  BANCOS: "111005",
  /** Saldo en la pasarela (kushki_*). */
  PASARELA: "112005",
  /** Bonos empresariales por redimir (pasivo). */
  BONOS_POR_REDIMIR: "280510",
  /** Clientes nacionales: ventas a crédito (customer_credit) y sus abonos. */
  CLIENTES: "130505",
  /**
   * Saldo a favor del proveedor: lo que una nota crédito (o, después, un
   * pago de más) deja a nuestro favor sin factura que cancelar. 1330
   * «Anticipos y avances» › 133005 «A proveedores»: es un derecho a cobrar o
   * a descontar de compras futuras, no una deuda negativa escondida en 2205.
   * La nota lo debita entera; cada cruce con una factura lo pasa a
   * Proveedores/Costos y gastos por pagar y un reintegro en dinero lo
   * cancela contra caja/banco. El contador puede abrir auxiliares debajo
   * (p. ej. 13300510 «Saldos a favor por notas crédito»): el motor asienta
   * en la auxiliar (`resolvePostableCode`).
   */
  SALDO_A_FAVOR_PROVEEDORES: "133005",
  INVENTARIO: "143505",
  PROVEEDORES: "220505",
  /** Costos y gastos por pagar: el gasto nace acá y se cancela al pagarse. */
  GASTOS_POR_PAGAR: "233505",
  RETEFUENTE: "236505",
  RETEIVA: "236705",
  RETEICA: "236805",
  PROPINAS_POR_PAGAR: "238030",
  /**
   * Reintegros por pagar: lo que el comercio le debe al cliente por una
   * nota crédito aceptada cuya venta NO quedó en cartera (se cobró con
   * efectivo, datáfono, pasarela…). Nace con el asiento «Notas crédito del
   * mes» y se cancela cuando el reembolso sale por la pasarela (asiento
   * «Devoluciones del mes»).
   *
   * Por qué 2380 (acreedores varios) y no 2805 (anticipos y avances
   * recibidos): 2805 es plata que el cliente entregó ANTES de recibir el
   * bien o servicio (un anticipo, pasivo contractual); acá la venta ya se
   * hizo y se reversó con la nota — es una obligación de devolver dinero,
   * un acreedor más. Se usa la subcuenta 238020 «Reintegros por pagar» del
   * PUC (Decreto 2650 de 1993), que es justamente ese concepto. Lo valida
   * el contador.
   */
  DEVOLUCIONES_POR_PAGAR: "238020",
  INC_GENERADO: "241205",
  ICA_POR_PAGAR: "241605",
  INGRESOS: "413505",
  DEVOLUCIONES: "417505",
  /**
   * Notas crédito de proveedores por DESCUENTO CONDICIONADO (pronto pago):
   * ingreso financiero, PUC 421040 «Descuentos comerciales condicionados».
   */
  DESCUENTOS_CONDICIONADOS: "421040",
  GASTOS_DIVERSOS: "519505",
  COSTO_VENTAS: "613505",
  /**
   * Notas crédito de proveedores que bajan el COSTO (NIIF PYMES 13.6: los
   * descuentos comerciales y rebajas se restan del costo de adquisición).
   * Subcuentas propias de naturaleza crédito dentro de 6135, para verlas
   * como renglón aparte en el balance de prueba y los libros:
   *  · 613570 descuentos comerciales y rebajas puntuales;
   *  · 613575 acuerdos comerciales (bonificaciones por volumen, metas o
   *    convenios) — además, renglón propio en el estado de resultado.
   * Van al costo de ventas y no al inventario (1435): en un restaurante la
   * mercancía de la factura ya se consumió casi siempre y el kardex no se
   * revaloriza; acreditar 1435 lo descuadraría contra el kardex.
   */
  DESCUENTOS_COMPRAS: "613570",
  ACUERDOS_COMERCIALES: "613575",
  DEPRECIACION_GASTO: "516005",
  DEPRECIACION_ACUMULADA: "159205",
  // Nómina
  NOMINA_SALARIOS: "510506",
  NOMINA_APORTES: "510527",
  SALARIOS_POR_PAGAR: "250505",
  RETENCIONES_Y_APORTES_NOMINA: "237005",
  CESANTIAS: "251005",
  PRIMA: "252005",
  VACACIONES: "252505",
  // Heurística gasto-por-categoría (expenseAccountFor)
  ARRIENDOS: "512010",
  HONORARIOS: "511005",
  TELECOMUNICACIONES: "513535",
  SERVICIOS_PUBLICOS: "513505",
  MANTENIMIENTO: "514505",
  COMISIONES: "524505",
  PUBLICIDAD: "529505",
  // Cierre del ejercicio (fiscal.ts)
  UTILIDAD_EJERCICIO: "360505",
  PERDIDA_EJERCICIO: "361005",
  // IVA generado por tarifa (ivaGeneradoCodeForPct) y descontable
  IVA_GENERADO_19: "24080501",
  IVA_GENERADO_5: "24080503",
  IVA_GENERADO_0: "24080505",
  IVA_DESCONTABLE: IVA_DESCONTABLE_CODE,
} as const;

export type EngineCode = (typeof ENGINE)[keyof typeof ENGINE];

/** Todos los códigos base del motor, para consultas rápidas. */
export const ENGINE_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(ENGINE),
);

export function isEngineCode(code: string): boolean {
  return ENGINE_CODES.has(code);
}

/**
 * Fuentes de los asientos-resumen que arma el motor (`posting.ts`,
 * `buildMonthEntries`). Las comparten el motor (borra las que este mes ya
 * no producen asiento) y la corrida automática (`autoJournal.ts`). Un test
 * compara la lista con el código del motor para que no se desincronicen.
 */
export const ENGINE_SOURCES = [
  "sale",
  "customer_credit_payment",
  "purchase",
  "purchase_payment",
  "cogs",
  "waste",
  "expense",
  "expense_payment",
  "depreciation",
  "deferred",
  "payroll",
  "refund",
  "credit_note",
  // Notas crédito de proveedores (erp/supplierCreditNotePosting.ts): la
  // nota, su anulación, los cruces con facturas y los reintegros en dinero.
  "supplier_credit_note",
  "supplier_credit_note_void",
  "supplier_credit_apply",
  "supplier_credit_refund",
  // Pagos a proveedores con comprobante de egreso (supplierPaymentPosting.ts).
  "supplier_payment",
  "supplier_payment_void",
] as const;
