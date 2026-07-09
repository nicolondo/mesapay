import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { DianCertError, encryptSecret, loadP12 } from "@/lib/dian/crypto";
import {
  dianConfigStatus,
  resolveEmisor,
  upsertDianConfig,
} from "@/lib/dian/config";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["einvoicing"];
const MAX_BYTES = 512 * 1024; // los .p12 pesan pocos KB

/**
 * Sube el certificado digital (.p12) + contraseña. Se valida (debe abrir
 * con la contraseña), se cifra at rest y se guardan subject/vencimiento.
 * La contraseña y el .p12 NUNCA vuelven al cliente.
 */
export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.DIAN_MASTER_KEY ?? "")) {
    return NextResponse.json({ error: "master_key_missing" }, { status: 503 });
  }
  const emisor = await resolveEmisor(ctx.restaurantId);
  if (!emisor) return NextResponse.json({ error: "no_emisor" }, { status: 400 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const password = String(form?.get("password") ?? "");
  if (!(file instanceof File) || !password) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (file.size > MAX_BYTES || file.size === 0) {
    return NextResponse.json({ error: "bad_size" }, { status: 400 });
  }
  const p12 = Buffer.from(await file.arrayBuffer());

  let loaded;
  try {
    loaded = loadP12(p12, password);
  } catch (err) {
    if (err instanceof DianCertError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }

  await upsertDianConfig(emisor, {
    certP12Enc: Buffer.from(encryptSecret(p12), "base64"),
    certPasswordEnc: encryptSecret(Buffer.from(password, "utf8")),
    certSubject: loaded.subject,
    certNotAfter: loaded.notAfter,
  });

  const { status } = await dianConfigStatus(ctx.restaurantId);
  return NextResponse.json({ status });
}
