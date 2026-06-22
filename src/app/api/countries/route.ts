import { NextResponse } from "next/server";
import { getEnabledCountries } from "@/lib/billing/countries";

export const dynamic = "force-dynamic";

/**
 * Países habilitados para el alta pública de restaurantes (signup).
 * Público: solo expone code + name (sin moneda ni datos sensibles).
 */
export async function GET() {
  const countries = await getEnabledCountries();
  return NextResponse.json({
    countries: countries.map((c) => ({ code: c.code, name: c.name })),
  });
}
