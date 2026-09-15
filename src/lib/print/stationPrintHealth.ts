/**
 * ¿Qué le pasa a la comanda de cada estación con la configuración que hay?
 *
 * La impresión se decide en dos pantallas que no se miraban entre sí:
 * Estaciones tiene los toggles "imprimir" y "marchar automáticamente" por
 * estación, e Impresoras de red tiene las impresoras que el agente reporta.
 * Las dos configuraciones incoherentes más comunes —impresión del bar
 * encendida sin ninguna impresora de bar activa, e impresora de bar activa
 * con la impresión del bar apagada— no dejaban rastro en ningún lado: la
 * comanda se marchaba sola y no salía nada (Son y Melona, #440).
 *
 * Todo lo que "está incoherente" se decide ACÁ, puro y sin DB, y las tres
 * pantallas (Estaciones, Impresoras de red y el hub de Configuración) lo
 * consumen para decir lo mismo. La cuenta de impresoras replica exactamente
 * lo que mira `enqueueRoundTicket`: tipo comanda, misma estación, activa —
 * y la cobertura por sub-estación usa el mismo `printerMatches`.
 */
import { printerMatches, type TicketStation } from "./routing";

export type StationPrintFlags = {
  kitchenPrintEnabled: boolean;
  barPrintEnabled: boolean;
  kitchenAutoFire: boolean;
  barAutoFire: boolean;
};

/** Lo mínimo de `Printer` que hace falta para decidir. */
export type HealthPrinter = {
  kind: string;
  station: string | null;
  barSubStation: string | null;
  active: boolean;
};

export type StationPrintIssue =
  /**
   * Impresión encendida y ninguna impresora activa de la estación: la
   * comanda se marcha y `enqueueRoundTicket` no encola nada. Sólo se
   * levanta si el comercio usa impresoras de red (tiene alguna
   * registrada, aunque esté apagada): sin ninguna, imprime desde la
   * pestaña del navegador y no hay nada roto.
   */
  | "print_on_no_printer"
  /**
   * Impresión encendida y hay impresoras, pero alguna sub-estación del bar
   * no tiene ni impresora propia ni una "de toda la barra": sus comandas
   * se marchan y no salen.
   */
  | "print_on_sub_uncovered"
  /**
   * Marchado automático con la impresión apagada: los pedidos pasan a
   * "Preparando" solos y no sale papel. No es un error —hay locales que
   * miran el tablero— pero conviene saberlo.
   */
  | "auto_fire_print_off"
  /**
   * Hay impresora activa de la estación pero la impresión está apagada
   * en Estaciones: esa impresora nunca va a recibir una comanda.
   */
  | "printer_print_off";

export type StationPrintHealth = {
  station: TicketStation;
  printEnabled: boolean;
  autoFire: boolean;
  /**
   * Impresoras de comanda activas de la estación. En el bar cuentan todas:
   * las "de toda la barra" y las de una sub-estación.
   */
  activePrinters: number;
  /** Sub-estaciones del bar sin ninguna impresora que las sirva. Vacío en cocina. */
  uncoveredBarSubStations: string[];
  issues: StationPrintIssue[];
};

export type StationPrintHealthInput = StationPrintFlags & {
  printers: HealthPrinter[];
  /**
   * `Restaurant.barSubStations`. Sin esto no se evalúa la cobertura por
   * sub-estación (el hub no la necesita).
   */
  barSubStations?: string[];
};

export type StationPrintHealthByStation = Record<
  TicketStation,
  StationPrintHealth
>;

export function stationPrintHealth(
  input: StationPrintHealthInput,
): StationPrintHealthByStation {
  // "Usa impresoras de red" = registró alguna, del tipo y estado que sea.
  // Una impresora apagada por reparación sigue contando: ese local imprime
  // por el agente y una estación sin impresora activa es un hueco real.
  const usesNetworkPrinting = input.printers.length > 0;

  const one = (
    station: TicketStation,
    printEnabled: boolean,
    autoFire: boolean,
  ): StationPrintHealth => {
    const own = input.printers.filter(
      (p) => p.active && p.kind === "comanda" && p.station === station,
    );
    const uncoveredBarSubStations =
      station === "bar"
        ? (input.barSubStations ?? []).filter(
            (sub) => !own.some((p) => printerMatches(p, "bar", sub)),
          )
        : [];

    const issues: StationPrintIssue[] = [];
    if (printEnabled && usesNetworkPrinting) {
      if (own.length === 0) issues.push("print_on_no_printer");
      else if (uncoveredBarSubStations.length > 0) {
        issues.push("print_on_sub_uncovered");
      }
    }
    if (autoFire && !printEnabled) issues.push("auto_fire_print_off");
    if (!printEnabled && own.length > 0) issues.push("printer_print_off");

    return {
      station,
      printEnabled,
      autoFire,
      activePrinters: own.length,
      uncoveredBarSubStations,
      issues,
    };
  };

  return {
    kitchen: one("kitchen", input.kitchenPrintEnabled, input.kitchenAutoFire),
    bar: one("bar", input.barPrintEnabled, input.barAutoFire),
  };
}

/**
 * Estaciones cuya impresión está encendida y a las que les falta impresora
 * (ninguna, o alguna sub-estación sin cubrir). Es lo que el hub resume como
 * "impresión activa sin impresora".
 */
export function stationsMissingPrinter(
  health: StationPrintHealthByStation,
): TicketStation[] {
  return (["kitchen", "bar"] as const).filter((s) =>
    health[s].issues.some(
      (i) => i === "print_on_no_printer" || i === "print_on_sub_uncovered",
    ),
  );
}

/**
 * Para la fila de una impresora en Impresoras de red: si es una impresora
 * de comanda activa y la impresión de su estación está apagada, devuelve
 * esa estación (la fila avisa que no va a recibir comandas). Una de
 * factura o una apagada no tienen nada que avisar.
 */
export function printerBlockedByStation(
  printer: HealthPrinter,
  health: StationPrintHealthByStation,
): TicketStation | null {
  if (!printer.active || printer.kind !== "comanda") return null;
  if (printer.station !== "kitchen" && printer.station !== "bar") return null;
  return health[printer.station].issues.includes("printer_print_off")
    ? printer.station
    : null;
}
