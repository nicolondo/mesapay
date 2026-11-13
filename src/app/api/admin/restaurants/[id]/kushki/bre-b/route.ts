import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { secureApi } from "@/lib/secureApi";
import { BRE_B_CREDENTIAL_METHODS, resolveEnabledPaymentMethods } from "@/lib/paymentMethods";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { maskEncryptedTail, maskKeyTail, readBreBCredentials } from "@/lib/payments/breB/credentials";
import { breBFailureLabel, breBGatewayFor, breBStartError } from "@/lib/payments/breB/gateway";
import { BRE_B_OPEN_STATES } from "@/lib/payments/breB/view";

export const dynamic = "force-dynamic";

/**
 * Credenciales del comercio Bre-B de Kushki de un restaurante. Sólo
 * administradores de plataforma.
 *
 * Kushki entrega para Bre-B un comercio DISTINTO al de tarjeta/PSE: otro
 * par de llaves y otra firma de webhook. Van aparte de
 * `/api/admin/restaurants/[id]/kushki` a propósito: guardar el formulario de
 * tarjeta no puede pisar ni borrar las de Bre-B.
 *
 *   GET    → qué hay cargado, ENMASCARADO (sólo los últimos 4). Ninguna
 *            llave vuelve entera nunca, ni la pública.
 *   PUT    → guarda o reemplaza. La privada y la firma se cifran igual que
 *            `kushkiPrivateKeyEnc`. Rechaza llaves iguales a las de
 *            tarjeta/PSE/dispersión (`same_as_card_keys`).
 *   DELETE → borra todo y apaga el medio `kushki_bre_b`.
 *   POST   → «Verificar con Kushki»: lee el config del comercio con las
 *            llaves guardadas y dice si Kushki ya le habilitó el procesador
 *            Bre-B (lo activa el ejecutivo de cuenta). En modo mock no sale
 *            ninguna petición.
 *
 * Reemplazar o borrar con un QR vivo dejaría ese cobro sin poder
 * consultarse ni cancelarse: se rechaza (`bre_b_charges_in_flight`) hasta
 * que se resuelva. Todo cambio queda en la auditoría, sin secretos.
 */

const SELECT = {
  id: true,
  name: true,
  kushkiPublicKey: true,
  kushkiPrivateKeyEnc: true,
  kushkiPayoutPublicKey: true,
  kushkiPayoutPrivateKeyEnc: true,
  kushkiBreBMerchantId: true,
  kushkiBreBMerchantName: true,
  kushkiBreBPublicKey: true,
  kushkiBreBPrivateKeyEnc: true,
  kushkiBreBWebhookSecretEnc: true,
  enabledPaymentMethods: true,
  kushkiMode: true,
} as const;

type Row = NonNullable<Awaited<ReturnType<typeof load>>>;

function load(id: string) {
  return db.restaurant.findUnique({ where: { id }, select: SELECT });
}

function masked(rest: Row) {
  return {
    configured: !!rest.kushkiBreBPublicKey && !!rest.kushkiBreBPrivateKeyEnc,
    merchantId: rest.kushkiBreBMerchantId,
    merchantName: rest.kushkiBreBMerchantName,
    publicKeyTail: maskKeyTail(rest.kushkiBreBPublicKey),
    privateKeyTail: maskEncryptedTail(rest.kushkiBreBPrivateKeyEnc),
    webhookSecretTail: maskEncryptedTail(rest.kushkiBreBWebhookSecretEnc),
    enabled: resolveEnabledPaymentMethods(rest.enabledPaymentMethods).includes("kushki_bre_b"),
  };
}

async function admin() {
  const session = await auth();
  return session?.user && session.user.role === "platform_admin" ? session.user : null;
}

function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

function openCharges(restaurantId: string) {
  return db.breBCharge.count({ where: { restaurantId, status: { in: [...BRE_B_OPEN_STATES] } } });
}

async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await admin())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const rest = await load(id);
  if (!rest) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(masked(rest));
}

const key = z.string().trim().min(8).max(500);
const schema = z.object({
  // Opcionales: sólo para reconocer el comercio y casar sus avisos.
  merchantId: z.string().trim().max(200).nullable().optional(),
  merchantName: z.string().trim().max(200).nullable().optional(),
  // Omitida = se conserva la guardada. No hay forma de leerla de vuelta.
  publicKey: key.optional(),
  privateKey: key.optional(),
  // "" = borrar la firma; omitida = conservarla.
  webhookSecret: z.string().trim().max(500).optional(),
});

async function PUTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await admin();
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const rest = await load(id);
  if (!rest) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const input = parsed.data;

  const currentPrivate = safeDecrypt(rest.kushkiBreBPrivateKeyEnc);
  const publicKey = input.publicKey ?? rest.kushkiBreBPublicKey;
  const privateKey = input.privateKey ?? currentPrivate;
  // Las dos llaves, siempre: una sola no cobra.
  if (!publicKey || !privateKey) return NextResponse.json({ error: "keys_required" }, { status: 400 });
  if (publicKey === privateKey) return NextResponse.json({ error: "keys_identical" }, { status: 400 });

  // Bre-B es OTRO comercio: si son las llaves de tarjeta/PSE (o las de
  // dispersión), alguien pegó las que no eran.
  const cardKeys = [
    rest.kushkiPublicKey,
    safeDecrypt(rest.kushkiPrivateKeyEnc),
    rest.kushkiPayoutPublicKey,
    safeDecrypt(rest.kushkiPayoutPrivateKeyEnc),
  ].filter((k): k is string => !!k);
  if (cardKeys.includes(publicKey) || cardKeys.includes(privateKey)) {
    return NextResponse.json({ error: "same_as_card_keys" }, { status: 400 });
  }

  const hadKeys = !!rest.kushkiBreBPublicKey && !!rest.kushkiBreBPrivateKeyEnc;
  const keysChange = publicKey !== rest.kushkiBreBPublicKey || privateKey !== currentPrivate;
  if (hadKeys && keysChange && (await openCharges(id)) > 0) {
    return NextResponse.json({ error: "bre_b_charges_in_flight" }, { status: 409 });
  }

  const data: Record<string, string | null> = { kushkiBreBPublicKey: publicKey };
  if (input.merchantId !== undefined) data.kushkiBreBMerchantId = input.merchantId || null;
  if (input.merchantName !== undefined) data.kushkiBreBMerchantName = input.merchantName || null;
  try {
    if (input.privateKey !== undefined || !rest.kushkiBreBPrivateKeyEnc) {
      data.kushkiBreBPrivateKeyEnc = encrypt(privateKey);
    }
    if (input.webhookSecret !== undefined) {
      data.kushkiBreBWebhookSecretEnc = input.webhookSecret ? encrypt(input.webhookSecret) : null;
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: "encrypt_failed",
        detail: err instanceof Error ? err.message.split("\n")[0] : "missing MESAPAY_SECRET_KEY",
      },
      { status: 500 },
    );
  }

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.restaurant.update({ where: { id }, data, select: SELECT });
    await tx.auditEvent.create({
      data: {
        restaurantId: id,
        actorUserId: user.id,
        actorEmail: user.email ?? "",
        actorRole: user.role,
        kind: hadKeys ? "restaurant.kushki_bre_b_credentials_replaced" : "restaurant.kushki_bre_b_credentials_saved",
        targetType: "restaurant",
        targetId: id,
        summary: hadKeys
          ? `Reemplazó las credenciales Bre-B de ${rest.name}`
          : `Cargó las credenciales Bre-B de ${rest.name}`,
        // Sólo los últimos 4: la auditoría nunca guarda una llave.
        diff: {
          keysChanged: keysChange,
          publicKeyTail: maskKeyTail(publicKey),
          privateKeyTail: maskKeyTail(privateKey),
          webhookSecret:
            input.webhookSecret === undefined ? "unchanged" : input.webhookSecret ? "set" : "cleared",
          merchantId: row.kushkiBreBMerchantId,
          merchantName: row.kushkiBreBMerchantName,
        },
      },
    });
    return row;
  });
  return NextResponse.json({ ok: true, ...masked(updated) });
}

async function DELETEHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await admin();
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const rest = await load(id);
  if (!rest) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if ((await openCharges(id)) > 0) {
    return NextResponse.json({ error: "bre_b_charges_in_flight" }, { status: 409 });
  }
  // Sin llaves el medio no puede quedar prendido. `null` (= "todo
  // habilitado") no lo incluye, así que sólo se toca una lista explícita.
  const stored = rest.enabledPaymentMethods;
  const methods = Array.isArray(stored)
    ? stored.filter((m) => typeof m !== "string" || !(BRE_B_CREDENTIAL_METHODS as readonly string[]).includes(m))
    : null;
  const updated = await db.$transaction(async (tx) => {
    const row = await tx.restaurant.update({
      where: { id },
      data: {
        kushkiBreBMerchantId: null,
        kushkiBreBMerchantName: null,
        kushkiBreBPublicKey: null,
        kushkiBreBPrivateKeyEnc: null,
        kushkiBreBWebhookSecretEnc: null,
        ...(methods ? { enabledPaymentMethods: methods as object } : {}),
      },
      select: SELECT,
    });
    await tx.auditEvent.create({
      data: {
        restaurantId: id,
        actorUserId: user.id,
        actorEmail: user.email ?? "",
        actorRole: user.role,
        kind: "restaurant.kushki_bre_b_credentials_cleared",
        targetType: "restaurant",
        targetId: id,
        summary: `Borró las credenciales Bre-B de ${rest.name}`,
        diff: {
          publicKeyTail: maskKeyTail(rest.kushkiBreBPublicKey),
          methodDisabled: Array.isArray(stored) && methods !== null && methods.length !== stored.length,
        },
      },
    });
    return row;
  });
  return NextResponse.json({ ok: true, ...masked(updated) });
}

async function POSTHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await admin())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const rest = await load(id);
  if (!rest) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const mode = await getRestaurantKushkiMode(rest);
  const creds = readBreBCredentials(rest);
  if (!creds) return NextResponse.json({ error: "keys_required" }, { status: 409 });
  try {
    const processor = await breBGatewayFor(mode, creds).processor({ fresh: true });
    return NextResponse.json({
      ok: true,
      mode,
      processor: processor?.name ?? null,
      channel: processor?.channel ?? null,
    });
  } catch (err) {
    // La verificación corrió y Kushki no respondió bien: se dice qué pasó
    // (credencial inválida, sin respuesta…), nunca el cuerpo de la respuesta.
    console.warn("[admin/bre-b] verify failed", { restaurantId: id, failure: breBFailureLabel(err) });
    return NextResponse.json({ ok: false, mode, error: breBStartError(err) });
  }
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
export const PUT = secureApi(PUTHandler);
export const DELETE = secureApi(DELETEHandler);
