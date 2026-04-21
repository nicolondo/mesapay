import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

const schema = z.object({
  restaurantName: z.string().trim().min(1).max(80),
  restaurantSlug: z.string().trim().min(2).max(40),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email(),
  password: z.string().min(6).max(120),
});

function normalizeSlug(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

const RESERVED = new Set([
  "www",
  "api",
  "admin",
  "app",
  "signin",
  "signup",
  "operator",
  "operador",
  "t",
  "mesapay",
]);

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  const slug = normalizeSlug(parsed.data.restaurantSlug);
  if (slug.length < 2 || RESERVED.has(slug)) {
    return NextResponse.json(
      { error: "Ese identificador no es válido. Intenta con otro." },
      { status: 400 },
    );
  }

  const [existingUser, existingRestaurant] = await Promise.all([
    db.user.findUnique({ where: { email } }),
    db.restaurant.findUnique({ where: { slug } }),
  ]);
  if (existingUser) {
    return NextResponse.json(
      { error: "Ya existe una cuenta con ese correo" },
      { status: 409 },
    );
  }
  if (existingRestaurant) {
    return NextResponse.json(
      { error: "Ese identificador de restaurante ya está en uso" },
      { status: 409 },
    );
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  const result = await db.$transaction(async (tx) => {
    const restaurant = await tx.restaurant.create({
      data: {
        slug,
        name: parsed.data.restaurantName,
      },
    });

    const user = await tx.user.create({
      data: {
        email,
        name: parsed.data.name,
        passwordHash,
        role: "operator",
        restaurantId: restaurant.id,
      },
    });

    await tx.category.createMany({
      data: [
        { restaurantId: restaurant.id, slug: "entradas", label: "Entradas", sortOrder: 0 },
        { restaurantId: restaurant.id, slug: "platos", label: "Platos fuertes", sortOrder: 1 },
        { restaurantId: restaurant.id, slug: "bebidas", label: "Bebidas", sortOrder: 2 },
        { restaurantId: restaurant.id, slug: "postres", label: "Postres", sortOrder: 3 },
      ],
    });

    await tx.table.create({
      data: {
        restaurantId: restaurant.id,
        number: 1,
        qrToken: randomBytes(16).toString("hex"),
      },
    });

    return { restaurant, user };
  });

  return NextResponse.json({
    ok: true,
    userId: result.user.id,
    restaurantSlug: result.restaurant.slug,
  });
}
