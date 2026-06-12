import { NextResponse } from "next/server";
import { getBuildId } from "@/lib/buildId";

export const dynamic = "force-dynamic";

/** Versión del build que está sirviendo este proceso. Lo consulta
 *  StaleBuildReload para detectar pestañas con un bundle viejo. */
export async function GET() {
  return NextResponse.json(
    { buildId: getBuildId() },
    { headers: { "cache-control": "no-store" } },
  );
}
