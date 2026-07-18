// Capa de datos de nómina: junta salario base (Employee), recargos del mes
// (Horarios) y parámetros del comercio, liquida con la lógica pura de
// payroll.ts y persiste la corrida mensual (regenerable, snapshot en items).
import { db } from "@/lib/db";
import type { MonthRange } from "./accountingData";
import { derivedHourlyCents, shiftSurcharge } from "./staff";
import { holidaysForYear, isSunday } from "./holidays";
import {
  defaultPayrollParams,
  liquidateEmployeeCO,
  type PayrollParams,
} from "./payroll";

/** Recargos festivo/dominical del mes POR EMPLEADO (mismas reglas que el P&L). */
async function recargosByEmployee(
  restaurantId: string,
  range: MonthRange,
  tenant: {
    country: string | null;
    staffStrictAttendance: boolean;
    staffHolidayPct: number;
    staffSundayPct: number;
    staffHoursDivisor: number;
  },
): Promise<Map<string, number>> {
  const shifts = await db.staffShift.findMany({
    where: { restaurantId, date: { gte: range.from, lt: range.to } },
    select: {
      employeeId: true,
      date: true,
      startMinutes: true,
      endMinutes: true,
      checkInAt: true,
      checkOutAt: true,
      employee: { select: { monthlySalaryCents: true } },
    },
  });
  const holidaySet = new Set([
    ...holidaysForYear(tenant.country, range.from.getUTCFullYear()),
    ...holidaysForYear(tenant.country, range.to.getUTCFullYear()),
  ]);
  const now = new Date();
  const out = new Map<string, number>();
  for (const sh of shifts) {
    const c = shiftSurcharge(
      {
        startMinutes: sh.startMinutes,
        endMinutes: sh.endMinutes,
        checkInAt: sh.checkInAt,
        checkOutAt: sh.checkOutAt,
        hourlyValueCents: derivedHourlyCents(
          sh.employee.monthlySalaryCents,
          tenant.staffHoursDivisor,
        ),
      },
      {
        isHoliday: holidaySet.has(sh.date.toISOString().slice(0, 10)),
        isSunday: isSunday(sh.date),
        holidayPct: tenant.staffHolidayPct,
        sundayPct: tenant.staffSundayPct,
        strict: tenant.staffStrictAttendance,
        now,
        shiftDate: sh.date,
      },
    );
    if (c.surchargeCents > 0) {
      out.set(
        sh.employeeId,
        (out.get(sh.employeeId) ?? 0) + c.surchargeCents,
      );
    }
  }
  return out;
}

/** Parámetros efectivos del comercio (custom ?? defaults por país). */
export function effectiveParams(
  payrollParams: unknown,
  country: string | null,
): PayrollParams {
  if (payrollParams && typeof payrollParams === "object") {
    const out: PayrollParams = {};
    for (const [k, v] of Object.entries(payrollParams as object)) {
      if (typeof v === "number" && !Number.isNaN(v)) out[k] = v;
    }
    return out;
  }
  return defaultPayrollParams(country);
}

/**
 * Genera (o regenera) la corrida del mes: liquida cada empleado activo con
 * salario y persiste el snapshot de conceptos. Idempotente por (comercio, mes).
 */
export async function generatePayrollRun(
  restaurantId: string,
  month: string,
  range: MonthRange,
): Promise<void> {
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      country: true,
      payrollParams: true,
      staffStrictAttendance: true,
      staffHolidayPct: true,
      staffSundayPct: true,
      staffHoursDivisor: true,
    },
  });
  if (!tenant) return;
  const params = effectiveParams(tenant.payrollParams, tenant.country);
  const [employees, recargos] = await Promise.all([
    db.employee.findMany({
      where: { restaurantId, active: true, monthlySalaryCents: { not: null } },
      select: { id: true, name: true, monthlySalaryCents: true },
      orderBy: { name: "asc" },
    }),
    recargosByEmployee(restaurantId, range, tenant),
  ]);

  const items: Array<{
    employeeId: string;
    employeeName: string;
    conceptKey: string;
    conceptLabel: string;
    kind: string;
    amountCents: number;
  }> = [];
  for (const e of employees) {
    const liq = liquidateEmployeeCO(
      e.monthlySalaryCents ?? 0,
      recargos.get(e.id) ?? 0,
      params,
    );
    for (const c of liq.items) {
      items.push({
        employeeId: e.id,
        employeeName: e.name,
        conceptKey: c.conceptKey,
        conceptLabel: c.conceptLabel,
        kind: c.kind,
        amountCents: c.amountCents,
      });
    }
  }

  await db.$transaction(async (tx) => {
    await tx.payrollRun.deleteMany({ where: { restaurantId, month } });
    if (items.length === 0) return;
    await tx.payrollRun.create({
      data: {
        restaurantId,
        month,
        status: "draft",
        items: { create: items },
      },
    });
  });
}

export type PayrollEmployeeDto = {
  employeeId: string;
  employeeName: string;
  items: Array<{
    conceptKey: string;
    conceptLabel: string;
    kind: string;
    amountCents: number;
  }>;
  totalDevengadoCents: number;
  totalDeduccionesCents: number;
  netoCents: number;
  totalEmpleadorCents: number;
};

export type PayrollRunDto = {
  exists: boolean;
  employees: PayrollEmployeeDto[];
  totals: {
    devengadoCents: number;
    deduccionesCents: number;
    netoCents: number;
    empleadorCents: number;
    costoTotalCents: number;
  };
};

/** Corrida del mes agrupada por empleado, con totales. */
export async function loadPayrollRun(
  restaurantId: string,
  month: string,
): Promise<PayrollRunDto> {
  const run = await db.payrollRun.findUnique({
    where: { restaurantId_month: { restaurantId, month } },
    include: { items: { orderBy: { employeeName: "asc" } } },
  });
  if (!run) {
    return {
      exists: false,
      employees: [],
      totals: {
        devengadoCents: 0,
        deduccionesCents: 0,
        netoCents: 0,
        empleadorCents: 0,
        costoTotalCents: 0,
      },
    };
  }
  const byEmp = new Map<string, PayrollEmployeeDto>();
  for (const it of run.items) {
    let e = byEmp.get(it.employeeId);
    if (!e) {
      e = {
        employeeId: it.employeeId,
        employeeName: it.employeeName,
        items: [],
        totalDevengadoCents: 0,
        totalDeduccionesCents: 0,
        netoCents: 0,
        totalEmpleadorCents: 0,
      };
      byEmp.set(it.employeeId, e);
    }
    e.items.push({
      conceptKey: it.conceptKey,
      conceptLabel: it.conceptLabel,
      kind: it.kind,
      amountCents: it.amountCents,
    });
    if (it.kind === "devengado") e.totalDevengadoCents += it.amountCents;
    else if (it.kind === "deduccion") e.totalDeduccionesCents += it.amountCents;
    else e.totalEmpleadorCents += it.amountCents;
  }
  const employees = [...byEmp.values()].map((e) => ({
    ...e,
    netoCents: e.totalDevengadoCents - e.totalDeduccionesCents,
  }));
  const totals = employees.reduce(
    (t, e) => ({
      devengadoCents: t.devengadoCents + e.totalDevengadoCents,
      deduccionesCents: t.deduccionesCents + e.totalDeduccionesCents,
      netoCents: t.netoCents + e.netoCents,
      empleadorCents: t.empleadorCents + e.totalEmpleadorCents,
      costoTotalCents:
        t.costoTotalCents + e.totalDevengadoCents + e.totalEmpleadorCents,
    }),
    {
      devengadoCents: 0,
      deduccionesCents: 0,
      netoCents: 0,
      empleadorCents: 0,
      costoTotalCents: 0,
    },
  );
  return { exists: true, employees, totals };
}

/** Totales por concepto para el asiento contable de nómina. */
export async function payrollTotalsForPosting(
  restaurantId: string,
  month: string,
): Promise<{
  devengadoCents: number;
  deduccionesCents: number;
  aportesCents: number;
  provCesantiasCents: number;
  provPrimaCents: number;
  provVacacionesCents: number;
} | null> {
  const run = await db.payrollRun.findUnique({
    where: { restaurantId_month: { restaurantId, month } },
    include: { items: { select: { conceptKey: true, kind: true, amountCents: true } } },
  });
  if (!run || run.items.length === 0) return null;
  const t = {
    devengadoCents: 0,
    deduccionesCents: 0,
    aportesCents: 0,
    provCesantiasCents: 0,
    provPrimaCents: 0,
    provVacacionesCents: 0,
  };
  for (const it of run.items) {
    if (it.kind === "devengado") t.devengadoCents += it.amountCents;
    else if (it.kind === "deduccion") t.deduccionesCents += it.amountCents;
    else if (it.kind === "aporte_empleador") t.aportesCents += it.amountCents;
    else if (it.kind === "provision") {
      if (it.conceptKey === "prima") t.provPrimaCents += it.amountCents;
      else if (it.conceptKey === "vacaciones")
        t.provVacacionesCents += it.amountCents;
      else t.provCesantiasCents += it.amountCents; // cesantías + intereses
    }
  }
  return t;
}
