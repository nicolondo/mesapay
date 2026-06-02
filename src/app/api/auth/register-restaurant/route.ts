import { NextResponse } from "next/server";
import { z } from "zod";
import { registerRestaurant } from "@/lib/registerRestaurant";

const schema = z.object({
  restaurantName: z.string().trim().min(1).max(80),
  restaurantSlug: z.string().trim().min(2).max(40),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email(),
  password: z.string().min(6).max(120),
  serviceMode: z.enum(["table", "counter"]).optional(),
  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  country: z.string().trim().max(2).optional(),
  countryName: z.string().trim().max(120).optional(),
  placeId: z.string().trim().max(300).optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  }

  const result = await registerRestaurant({
    restaurantName: parsed.data.restaurantName,
    restaurantSlug: parsed.data.restaurantSlug,
    ownerName: parsed.data.name,
    ownerEmail: parsed.data.email,
    ownerPassword: parsed.data.password,
    serviceMode: parsed.data.serviceMode,
    address: parsed.data.address,
    city: parsed.data.city,
    country: parsed.data.country,
    countryName: parsed.data.countryName,
    placeId: parsed.data.placeId,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    userId: result.userId,
    restaurantSlug: result.restaurantSlug,
  });
}
