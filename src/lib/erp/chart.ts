// Reglas del plan de cuentas: alta y edición de cuentas una por una (la
// importación masiva sigue en chartImport.ts), la regla de zenith "cuenta
// madre con movimientos → traslado atómico a la nueva auxiliar", el export
// CSV y el resolutor que usa el motor para no asentar nunca contra una
// agrupadora.
//
// Jerarquía por longitud de código: 1 clase · 2 grupo · 4 cuenta ·
// 6 subcuenta · 8 y 10 auxiliares. Sólo las cuentas `postable` reciben
// movimientos; en cuanto una recibe hijas deja de serlo.
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ENGINE_CODES } from "./engineCodes";
import {
  pucLevel,
  pucParentCode,
  type PucNature,
  type PucType,
} from "./pucNiif";

/** Longitudes que se pueden crear a mano: cuenta, subcuenta y auxiliares. */
export const NEW_ACCOUNT_LENGTHS: ReadonlySet<number> = new Set([4, 6, 8, 10]);
export const ACCOUNT_NAME_MIN = 2;
export const ACCOUNT_NAME_MAX = 120;

/** Cuenta tal como la ve el plan (y como la devuelve la API). */
export type PlanAccount = {
  code: string;
  name: string;
  type: PucType;
  nature: PucNature;
  postable: boolean;
  active: boolean;
};

export type LedgerAccountDto = PlanAccount & {
  level: number;
  parentCode: string | null;
};

/**
 * Nivel jerárquico ORDINAL: 1 clase · 2 grupo · 3 cuenta · 4 subcuenta ·
 * 5 auxiliar (8 dígitos o más). OJO: la columna `LedgerAccount.level`
 * guarda la LONGITUD del código (`pucLevel`), que es lo que persiste el
 * catálogo base y el importador; este ordinal es para razonar/validar.
 */
export function levelForCode(code: string): number {
  const len = code.length;
  if (len <= 1) return 1;
  if (len === 2) return 2;
  if (len <= 4) return 3;
  if (len <= 6) return 4;
  return 5;
}

/** Código de la madre: prefijo de la longitud inmediata inferior (10→8→6→4→2→1). */
export function parentCodeFor(code: string): string | null {
  return pucParentCode(code);
}

/** Clase PUC (primer dígito) → tipo. 7 = costos de producción → costo. */
const CLASS_TYPE: Record<string, PucType> = {
  "1": "activo",
  "2": "pasivo",
  "3": "patrimonio",
  "4": "ingreso",
  "5": "gasto",
  "6": "costo",
  "7": "costo",
};

/** Tipo por clase. Las clases 8 y 9 (cuentas de orden) no se permiten → null. */
export function typeForCode(code: string): PucType | null {
  return CLASS_TYPE[code[0] ?? ""] ?? null;
}

export function natureForType(type: PucType): PucNature {
  return type === "activo" || type === "gasto" || type === "costo"
    ? "debito"
    : "credito";
}

export type NewAccountInput = {
  code: string;
  name: string;
  parentCode: string;
};

export type NewAccountError =
  | "bad_code"
  | "bad_name"
  | "code_taken"
  | "bad_parent"
  | "bad_prefix";

export type NewAccountValidation =
  | { ok: true; code: string; name: string; parent: PlanAccount }
  | { ok: false; error: NewAccountError };

function toPlanMap(
  plan: ReadonlyMap<string, PlanAccount> | readonly PlanAccount[],
): ReadonlyMap<string, PlanAccount> {
  return Array.isArray(plan)
    ? new Map((plan as readonly PlanAccount[]).map((a) => [a.code, a]))
    : (plan as ReadonlyMap<string, PlanAccount>);
}

/** Normaliza un código escrito a mano: sin espacios ni guiones. */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s.-]/g, "");
}

/**
 * Valida una cuenta nueva contra el plan del comercio. Reglas:
 * - código sólo dígitos, de 4, 6, 8 o 10, clase 1..7;
 * - nombre de 2 a 120 caracteres;
 * - código único por comercio;
 * - la madre existe y está activa;
 * - el código extiende el de la madre con exactamente dos dígitos (así el
 *   árbol nunca queda con un nivel salteado).
 */
export function validateNewAccount(
  input: NewAccountInput,
  plan: ReadonlyMap<string, PlanAccount> | readonly PlanAccount[],
): NewAccountValidation {
  const byCode = toPlanMap(plan);
  const code = normalizeCode(input.code ?? "");
  if (
    !/^\d+$/.test(code) ||
    !NEW_ACCOUNT_LENGTHS.has(code.length) ||
    !typeForCode(code)
  ) {
    return { ok: false, error: "bad_code" };
  }
  const name = (input.name ?? "").trim();
  if (name.length < ACCOUNT_NAME_MIN || name.length > ACCOUNT_NAME_MAX) {
    return { ok: false, error: "bad_name" };
  }
  if (byCode.has(code)) return { ok: false, error: "code_taken" };
  const parent = byCode.get(normalizeCode(input.parentCode ?? ""));
  if (!parent || !parent.active) return { ok: false, error: "bad_parent" };
  if (parentCodeFor(code) !== parent.code) {
    return { ok: false, error: "bad_prefix" };
  }
  return { ok: true, code, name, parent };
}

export type PostableIndexEntry = { postable: boolean; active?: boolean };

/**
 * Cuenta IMPUTABLE a la que debe ir un movimiento dirigido a `code`. Es el
 * equivalente de `pickLeafDescendant` de zenith: el motor escribe contra
 * códigos base fijos (110505, 111005…), pero el contador puede abrir
 * auxiliares debajo (11100501 Bancolombia, 11100502 Davivienda) y entonces
 * la base deja de ser imputable.
 *
 * - si la cuenta es postable → ella misma;
 * - si es madre → su única descendiente postable activa; si hay varias, la
 *   convención `código + "05"`; si tampoco, la de menor código;
 * - si no tiene ninguna (o no existe) → null y el asiento se omite.
 */
export function resolvePostableCode(
  index:
    | ReadonlyMap<string, PostableIndexEntry>
    | readonly (PostableIndexEntry & { code: string })[],
  code: string,
): string | null {
  const byCode: ReadonlyMap<string, PostableIndexEntry> = Array.isArray(index)
    ? new Map(
        (index as readonly (PostableIndexEntry & { code: string })[]).map(
          (a) => [a.code, a],
        ),
      )
    : (index as ReadonlyMap<string, PostableIndexEntry>);
  const self = byCode.get(code);
  if (!self) return null;
  if (self.postable) return code;

  const leaves: string[] = [];
  for (const [c, a] of byCode) {
    if (c.length > code.length && c.startsWith(code) && a.postable && a.active !== false) {
      leaves.push(c);
    }
  }
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0]!;
  const conventional = `${code}05`;
  if (leaves.includes(conventional)) return conventional;
  return leaves.sort((a, b) => a.localeCompare(b))[0]!;
}

export const CHART_CSV_HEADER = [
  "code",
  "name",
  "type",
  "nature",
  "postable",
  "active",
] as const;

/**
 * Export del plan en el mismo dialecto que acepta `parseChartCsv` al
 * importar: separador `;`, BOM, encabezado con nombres que el importador
 * reconoce, `true`/`false` en las banderas. Lo que sale de acá se puede
 * volver a pegar en "Importar plan de cuentas" sin perder nada.
 */
export function chartToCsv(accounts: readonly PlanAccount[]): string {
  const esc = (v: string) =>
    /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = [
    CHART_CSV_HEADER.join(";"),
    ...accounts.map((a) =>
      [
        a.code,
        esc(a.name),
        a.type,
        a.nature,
        a.postable ? "true" : "false",
        a.active ? "true" : "false",
      ].join(";"),
    ),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ───────────────────────── Funciones de DB ─────────────────────────

type LedgerAccountRow = {
  id: string;
  code: string;
  name: string;
  type: PucType;
  nature: PucNature;
  level: number;
  parentCode: string | null;
  postable: boolean;
  active: boolean;
};

const ACCOUNT_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  nature: true,
  level: true,
  parentCode: true,
  postable: true,
  active: true,
} as const;

function toDto(a: LedgerAccountRow): LedgerAccountDto {
  return {
    code: a.code,
    name: a.name,
    type: a.type,
    nature: a.nature,
    level: a.level,
    parentCode: a.parentCode,
    postable: a.postable,
    active: a.active,
  };
}

export type CreateAccountResult =
  | { ok: true; account: LedgerAccountDto; transferredLines: number }
  | { ok: false; error: NewAccountError };

/**
 * Crea una cuenta bajo su madre en UNA transacción. Hereda tipo y
 * naturaleza de la madre y nace imputable. Si la madre era imputable (o
 * sea, pasa a tener hijas), deja de serlo y sus movimientos se TRASLADAN a
 * la nueva auxiliar — la regla `create_auxiliary_with_transfer` de zenith:
 * el saldo de la madre no se pierde, ahora vive en la hija. También migran
 * las referencias por código (gastos, abonos, retenciones, activos, reglas
 * de banco, presupuesto) que apuntaban exactamente a la madre, para que las
 * pantallas y el motor sigan encontrando la cuenta.
 */
export async function createAccount(
  restaurantId: string,
  input: NewAccountInput,
): Promise<CreateAccountResult> {
  try {
    return await db.$transaction(async (tx) => {
      const rows = await tx.ledgerAccount.findMany({
        where: { restaurantId },
        select: ACCOUNT_SELECT,
      });
      const plan = new Map<string, LedgerAccountRow>(rows.map((r) => [r.code, r]));
      const v = validateNewAccount(input, plan);
      if (!v.ok) return v;
      const parent = plan.get(v.parent.code)!;

      const created = await tx.ledgerAccount.create({
        data: {
          restaurantId,
          code: v.code,
          name: v.name,
          type: parent.type,
          nature: parent.nature,
          level: pucLevel(v.code),
          parentCode: parent.code,
          postable: true,
          active: true,
        },
        select: ACCOUNT_SELECT,
      });

      let transferredLines = 0;
      if (parent.postable) {
        const moved = await tx.journalLine.updateMany({
          where: { accountId: parent.id },
          data: { accountId: created.id, accountCode: created.code },
        });
        transferredLines = moved.count;
        await tx.ledgerAccount.update({
          where: { id: parent.id },
          data: { postable: false },
        });
        const byCode = { where: { restaurantId, accountCode: parent.code } };
        const toChild = { accountCode: created.code };
        await tx.expense.updateMany({ ...byCode, data: toChild });
        await tx.expensePayment.updateMany({ ...byCode, data: toChild });
        await tx.purchasePayment.updateMany({ ...byCode, data: toChild });
        await tx.retentionConcept.updateMany({ ...byCode, data: toChild });
        await tx.bankRecRule.updateMany({ ...byCode, data: toChild });
        await tx.budget.updateMany({ ...byCode, data: toChild });
        await tx.fixedAsset.updateMany({
          where: { restaurantId, assetAccountCode: parent.code },
          data: { assetAccountCode: created.code },
        });
      }
      return { ok: true, account: toDto(created), transferredLines };
    });
  } catch (e) {
    // Carrera entre dos altas del mismo código: el unique manda.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "code_taken" };
    }
    throw e;
  }
}

export type UpdateAccountInput = { name?: string; active?: boolean };

export type UpdateAccountError =
  | "not_found"
  | "bad_name"
  | "nothing_to_update"
  | "has_movements"
  | "engine_account"
  | "has_active_children"
  | "parent_inactive";

export type UpdateAccountResult =
  | { ok: true; account: LedgerAccountDto }
  | { ok: false; error: UpdateAccountError };

/**
 * Renombra o activa/desactiva una cuenta. NUNCA borra. No se puede
 * desactivar una cuenta con movimientos, una que el motor usa
 * (ENGINE_CODES) ni una madre con hijas activas; no se puede reactivar una
 * hija si su madre está inactiva (quedaría huérfana en el árbol).
 */
export async function updateAccount(
  restaurantId: string,
  rawCode: string,
  patch: UpdateAccountInput,
): Promise<UpdateAccountResult> {
  const code = normalizeCode(rawCode);
  const name = patch.name === undefined ? undefined : patch.name.trim();
  if (name === undefined && patch.active === undefined) {
    return { ok: false, error: "nothing_to_update" };
  }
  if (
    name !== undefined &&
    (name.length < ACCOUNT_NAME_MIN || name.length > ACCOUNT_NAME_MAX)
  ) {
    return { ok: false, error: "bad_name" };
  }

  return db.$transaction(async (tx) => {
    const current = await tx.ledgerAccount.findUnique({
      where: { restaurantId_code: { restaurantId, code } },
      select: ACCOUNT_SELECT,
    });
    if (!current) return { ok: false, error: "not_found" };

    if (patch.active === false && current.active) {
      if (ENGINE_CODES.has(code)) return { ok: false, error: "engine_account" };
      const lines = await tx.journalLine.count({
        where: { accountId: current.id },
      });
      if (lines > 0) return { ok: false, error: "has_movements" };
      const children = await tx.ledgerAccount.count({
        where: { restaurantId, parentCode: code, active: true },
      });
      if (children > 0) return { ok: false, error: "has_active_children" };
    }
    if (patch.active === true && !current.active && current.parentCode) {
      const parent = await tx.ledgerAccount.findUnique({
        where: { restaurantId_code: { restaurantId, code: current.parentCode } },
        select: { active: true },
      });
      if (parent && !parent.active) return { ok: false, error: "parent_inactive" };
    }

    const updated = await tx.ledgerAccount.update({
      where: { id: current.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      },
      select: ACCOUNT_SELECT,
    });
    return { ok: true, account: toDto(updated) };
  });
}
