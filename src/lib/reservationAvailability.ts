/**
 * Cálculo de disponibilidad de reservas. Separado de reservations.ts
 * (que es lógica pura sin DB) porque acá sí pegamos a Prisma.
 *
 * La pregunta que responde: para un restaurante + fecha + tamaño de
 * grupo, ¿qué slots tienen al menos una mesa libre, y cuáles mesas?
 *
 * Una mesa está libre para un slot si:
 *   - reservable = true
 *   - capacity >= partySize
 *   - no hay otra reserva activa (pending/confirmed/seated) que se
 *     solape con la ventana [slotStart, slotEnd)
 */

import { db } from "./db";
import {
  resolveReservationConfig,
  slotsForDay,
  slotToUtcRange,
  BOGOTA_OFFSET_HOURS,
  type ReservationConfig,
  type Weekday,
} from "./reservations";

export type AvailableTable = {
  id: string;
  number: number;
  label: string | null;
  capacity: number;
  minConsumptionCents: number | null;
};

/** Mesa con posición en el plano — para dibujar el mapa diner-side. */
export type FloorTable = {
  id: string;
  number: number;
  label: string | null;
  capacity: number;
  minConsumptionCents: number | null;
  shape: "square" | "round" | "bar";
  x: number;
  y: number;
};

export type AvailableSlot = {
  /** "HH:MM" hora local de inicio. */
  label: string;
  startMinutes: number;
  startsAt: Date;
  endsAt: Date;
  /** Mesas libres para este slot que entran al grupo. */
  tables: AvailableTable[];
};

/** Estados que ocupan una mesa (bloquean el slot). */
const BLOCKING_STATUSES = ["pending", "confirmed", "seated"] as const;

/** Weekday (0=dom) para una fecha local "YYYY-MM-DD" en Bogotá. */
export function weekdayForLocalDate(dateLocal: string): Weekday {
  const [y, m, d] = dateLocal.split("-").map(Number);
  // Construimos como UTC y leemos getUTCDay — al ser fecha sin hora,
  // el día de la semana es estable independiente del offset.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() as Weekday;
}

/**
 * Calcula disponibilidad. Devuelve los slots del día con sus mesas
 * libres. Slots sin mesas libres se incluyen igual (con tables: [])
 * para que el front pueda mostrarlos como "agotado" si querés — el
 * caller filtra si sólo quiere disponibles.
 */
export async function getAvailability(args: {
  restaurantId: string;
  dateLocal: string; // "2026-06-15"
  partySize: number;
  /** Para no ofrecer slots ya pasados / fuera de ventana. Default now. */
  now?: Date;
}): Promise<{
  config: ReservationConfig;
  slots: AvailableSlot[];
  /** Todas las mesas reservables ubicadas en el plano (con coords).
   *  Se usa para dibujar el mapa del salón en el lado del diner. Es
   *  independiente del partySize: incluye todas, el front marca cuáles
   *  son seleccionables comparando contra slot.tables. */
  floorTables: FloorTable[];
}> {
  const now = args.now ?? new Date();
  const r = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: { reservationsEnabled: true, reservationConfig: true },
  });
  const config = resolveReservationConfig(r?.reservationConfig);

  // Todas las mesas reservables ubicadas en el plano — para dibujar el
  // mapa. Independiente del partySize y de si el día tiene turnos.
  const placed = await db.table.findMany({
    where: {
      restaurantId: args.restaurantId,
      reservable: true,
      number: { gte: 0 },
      floorPlanX: { not: null },
      floorPlanY: { not: null },
    },
    select: {
      id: true,
      number: true,
      label: true,
      capacity: true,
      minConsumptionCents: true,
      shape: true,
      floorPlanX: true,
      floorPlanY: true,
    },
    orderBy: { number: "asc" },
  });
  const floorTables: FloorTable[] = placed.map((t) => ({
    id: t.id,
    number: t.number,
    label: t.label,
    capacity: t.capacity,
    minConsumptionCents: t.minConsumptionCents,
    shape: t.shape,
    x: t.floorPlanX as number,
    y: t.floorPlanY as number,
  }));

  if (!r?.reservationsEnabled) {
    return { config, slots: [], floorTables };
  }

  const weekday = weekdayForLocalDate(args.dateLocal);
  const daySlots = slotsForDay(config, weekday);
  if (daySlots.length === 0) {
    return { config, slots: [], floorTables };
  }

  // Mesas candidatas: reservables + capacidad suficiente.
  const tables = await db.table.findMany({
    where: {
      restaurantId: args.restaurantId,
      reservable: true,
      number: { gte: 0 }, // excluir pickup (-1)
      capacity: { gte: args.partySize },
    },
    select: {
      id: true,
      number: true,
      label: true,
      capacity: true,
      minConsumptionCents: true,
    },
    orderBy: { number: "asc" },
  });
  if (tables.length === 0) {
    return { config, slots: [], floorTables };
  }

  // Reservas activas que tocan ese día. Tomamos un rango generoso
  // (todo el día local en UTC) y filtramos overlap por slot en memoria.
  const [y, m, d] = args.dateLocal.split("-").map(Number);
  const dayStartLocalMs = Date.UTC(y, m - 1, d, 0, 0);
  const dayStartUtc = new Date(
    dayStartLocalMs - BOGOTA_OFFSET_HOURS * 60 * 60 * 1000,
  );
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);

  const reservations = await db.reservation.findMany({
    where: {
      restaurantId: args.restaurantId,
      status: { in: [...BLOCKING_STATUSES] },
      // Solapa con el día si empieza antes del fin del día y termina
      // después del inicio.
      startsAt: { lt: dayEndUtc },
      endsAt: { gt: dayStartUtc },
    },
    select: { tableId: true, startsAt: true, endsAt: true },
  });

  // Anticipación mínima + ventana máxima.
  const minBookableMs = now.getTime() + config.minNoticeHours * 60 * 60 * 1000;

  const slots: AvailableSlot[] = [];
  for (const slot of daySlots) {
    const { startsAt, endsAt } = slotToUtcRange(
      args.dateLocal,
      slot,
      config.slotMinutes,
    );
    // Slot ya pasó o no respeta la anticipación mínima → no ofrecer.
    if (startsAt.getTime() < minBookableMs) {
      continue;
    }
    const freeTables = tables.filter((t) => {
      const overlap = reservations.some(
        (res) =>
          res.tableId === t.id &&
          res.startsAt < endsAt &&
          res.endsAt > startsAt,
      );
      return !overlap;
    });
    slots.push({
      label: slot.label,
      startMinutes: slot.startMinutes,
      startsAt,
      endsAt,
      tables: freeTables,
    });
  }

  return { config, slots, floorTables };
}
