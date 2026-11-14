// Puerta común de las rutas del documento soporte: sesión de operador,
// comercio activo, módulo de facturación electrónica y —cuando hay un
// origen— el módulo de ese origen (gastos = contabilidad, compras =
// compras). Traduce SupportDocError a JSON estable para la pantalla.
import { NextResponse } from "next/server";
import { getErpContext, isDenied, type ErpContext } from "@/lib/erp/access";
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules";
import { SupportDocError, supportDocErrorStatus } from "./errors";
import type { SupportDocSourceType } from "./types";

export function isSourceType(v: unknown): v is SupportDocSourceType {
  return v === "expense" || v === "purchase_order";
}

/** El origen exige su propio módulo además del de facturación electrónica. */
export async function assertSourceModule(restaurantId: string, sourceType: SupportDocSourceType): Promise<void> {
  const r = await db.restaurant.findUnique({ where: { id: restaurantId }, select: { enabledModules: true } });
  const required = sourceType === "expense" ? "accounting" : "purchasing";
  if (!isModuleEnabled(r?.enabledModules, required)) throw new SupportDocError("module_disabled");
}

export async function supportDocApi(
  run: (ctx: ErpContext) => Promise<unknown>,
  status = 200,
): Promise<Response> {
  const ctx = await getErpContext(["einvoicing"]);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  try {
    return NextResponse.json(await run(ctx), { status });
  } catch (err) {
    if (err instanceof SupportDocError) {
      return NextResponse.json(
        { error: err.code, detail: err.detail },
        { status: supportDocErrorStatus(err.code) },
      );
    }
    throw err;
  }
}
