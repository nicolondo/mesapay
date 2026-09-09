import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getEnabledCountries } from "@/lib/billing/countries";

export const dynamic = "force-dynamic";

/**
 * Países habilitados para el alta pública de restaurantes (signup).
 * Público: solo expone code + name (sin moneda ni datos sensibles).
 */
async function GETHandler() {
  const countries = await getEnabledCountries();
  return NextResponse.json({
    countries: countries.map((c) => ({ code: c.code, name: c.name })),
  });
}

export const GET = secureApi(GETHandler);
