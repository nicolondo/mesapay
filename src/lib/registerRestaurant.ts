import { randomBytes } from "crypto";
import { z } from "zod";
import { type ServiceMode } from "@prisma/client";
import { db } from "./db";
import { isCountryEnabled } from "./billing/countries";
import {
  generateResetToken,
  hashResetToken,
  PENDING_PASSWORD_HASH,
  WELCOME_TOKEN_TTL_MS,
} from "./passwordReset";
import { sendRestaurantWelcomeEmail } from "./mailer";

// Restaurants register empty by design — the operator imports their
// real menu (Shopify / Justo / PDF / URL) or builds it from scratch
// in /operator/menu. Seeding sample dishes used to create busywork:
// you'd land in the editor, see a Bandeja Paisa you didn't put there,
// and have to delete 12 items before you could even start. Now they
// get a clean canvas plus an import shortcut on the menu page.

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

export function normalizeSlug(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export type RegisterRestaurantInput = {
  restaurantName: string;
  restaurantSlug: string;
  ownerName: string;
  ownerEmail: string;
  locale?: string;
  serviceMode?: ServiceMode;
  address?: string;
  city?: string;
  country?: string;
  countryName?: string;
  placeId?: string;
};

export type RegisterRestaurantResult =
  | {
      ok: true;
      restaurantId: string;
      restaurantSlug: string;
      userId: string;
      emailSent: boolean;
    }
  | {
      ok: false;
      error: string;
      status: number;
    };

export async function registerRestaurant(
  input: RegisterRestaurantInput,
): Promise<RegisterRestaurantResult> {
  const email = input.ownerEmail.trim().toLowerCase();
  const slug = normalizeSlug(input.restaurantSlug);
  if (!z.string().email().safeParse(email).success) {
    return { ok: false, error: "invalid_email", status: 400 };
  }
  if (slug.length < 2 || RESERVED.has(slug)) {
    return {
      ok: false,
      error: "slug_invalid",
      status: 400,
    };
  }

  const [existingUser, existingRestaurant] = await Promise.all([
    db.user.findUnique({ where: { email } }),
    db.restaurant.findUnique({ where: { slug } }),
  ]);
  if (existingUser) {
    return {
      ok: false,
      error: "email_exists",
      status: 409,
    };
  }
  if (existingRestaurant) {
    return {
      ok: false,
      error: "slug_exists",
      status: 409,
    };
  }

  const token = generateResetToken();

  const serviceMode: ServiceMode = input.serviceMode ?? "table";

  // Ubicación opcional: normalizamos (trim address/city, uppercase país ISO)
  // y dejamos null cuando viene vacío para no guardar strings en blanco.
  const address = input.address?.trim() || null;
  const city = input.city?.trim() || null;
  const country = input.country?.trim().toUpperCase() || null;
  const countryName = input.countryName?.trim() || null;
  const placeId = input.placeId?.trim() || null;

  // País obligatorio: define la moneda de cobro (suscripción + pagos).
  // Debe ser uno de los países habilitados en la config de plataforma.
  if (!country) {
    return { ok: false, error: "country_required", status: 400 };
  }
  if (!(await isCountryEnabled(country))) {
    return {
      ok: false,
      error: "country_disabled",
      status: 400,
    };
  }

  const result = await db.$transaction(async (tx) => {
    const restaurant = await tx.restaurant.create({
      data: {
        slug,
        name: input.restaurantName.trim(),
        serviceMode,
        address,
        city,
        country,
        countryName,
        placeId,
      },
    });

    const user = await tx.user.create({
      data: {
        email,
        name: input.ownerName.trim(),
        passwordHash: PENDING_PASSWORD_HASH,
        role: "operator",
        restaurantId: restaurant.id,
      },
    });

    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(Date.now() + WELCOME_TOKEN_TTL_MS),
      },
    });

    // One table (or mostrador, for counter-mode places) so the operator
    // has somewhere to test the diner flow before configuring the rest.
    // We don't seed categories or dishes — the menu starts empty.
    await tx.table.create({
      data: {
        restaurantId: restaurant.id,
        number: serviceMode === "counter" ? 0 : 1,
        label: serviceMode === "counter" ? "Mostrador" : null,
        qrToken: randomBytes(16).toString("hex"),
      },
    });

    return { restaurant, user };
  });

  const emailSent = await sendRestaurantWelcomeEmail(
    result.user,
    result.restaurant.name,
    token,
    input.locale,
  );
  return {
    ok: true,
    restaurantId: result.restaurant.id,
    restaurantSlug: result.restaurant.slug,
    userId: result.user.id,
    emailSent,
  };
}
