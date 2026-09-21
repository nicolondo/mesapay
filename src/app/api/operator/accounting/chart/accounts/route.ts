import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { createAccount } from "@/lib/erp/chart";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const bodySchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  parentCode: z.string().trim().min(1).max(20),
});

/**
 * Alta de una cuenta bajo su madre. Las reglas (código, nombre, prefijo,
 * traslado de movimientos si la madre era imputable) viven en
 * `createAccount`; acá sólo se mapea el resultado a HTTP: 201 con la
 * cuenta y las líneas trasladadas, 409 si el código ya existe, 400 con el
 * código del error de validación para que la UI lo traduzca.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const r = await createAccount(ctx.restaurantId, parsed.data);
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error },
      { status: r.error === "code_taken" ? 409 : 400 },
    );
  }
  return NextResponse.json(
    { account: r.account, transferredLines: r.transferredLines },
    { status: 201 },
  );
}

export const POST = secureApi(POSTHandler);
