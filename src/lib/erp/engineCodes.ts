// Códigos PUC contra los que escribe el motor contable: los asientos-resumen
// del mes (posting.ts), el cierre del ejercicio (fiscal.ts), la conciliación
// bancaria y el registro de declaraciones. Viven acá, compartidos, para que
// el plan de cuentas (chart.ts) sepa cuáles NO se pueden desactivar: si una
// de estas falta o queda inactiva, el asiento del mes se omite entero.
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
  INVENTARIO: "143505",
  PROVEEDORES: "220505",
  /** Costos y gastos por pagar: el gasto nace acá y se cancela al pagarse. */
  GASTOS_POR_PAGAR: "233505",
  RETEFUENTE: "236505",
  RETEIVA: "236705",
  RETEICA: "236805",
  PROPINAS_POR_PAGAR: "238030",
  INC_GENERADO: "241205",
  ICA_POR_PAGAR: "241605",
  INGRESOS: "413505",
  DEVOLUCIONES: "417505",
  GASTOS_DIVERSOS: "519505",
  COSTO_VENTAS: "613505",
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
