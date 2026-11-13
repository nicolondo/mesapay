import { NextResponse } from "next/server";
import { secureApi } from "@/lib/secureApi";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { unzipFirstXml } from "@/lib/dian/soap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Descarga el XML FIRMADO tal como se transmitió a la DIAN. */
async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(["einvoicing"]);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id } = await params;
  const doc = await db.supportDocument.findFirst({
    where: { id, restaurantId: ctx.restaurantId },
    select: { xmlZip: true, submissionFileName: true, documentNumber: true },
  });
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const xml = doc.xmlZip ? await unzipFirstXml(doc.xmlZip) : null;
  if (!xml) return NextResponse.json({ error: "no_xml" }, { status: 409 });
  const fileName = doc.submissionFileName ?? `${doc.documentNumber}.xml`;
  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "")}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const GET = secureApi(GETHandler);
