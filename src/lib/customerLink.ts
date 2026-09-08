/**
 * Quiénes son "los clientes" de un restaurante.
 *
 * ── El problema ───────────────────────────────────────────────────────
 * La cuenta del comensal es GLOBAL: `User.email` es único en toda la
 * plataforma y la misma persona come en varios restaurantes MESAPAY. Por
 * eso la lista de clientes NO puede ser "todos los `role = customer`":
 * eso le mostraría a cada restaurante la base de comensales de los demás
 * — nombre, correo y cédula de gente que nunca pisó su local. Son negocios
 * distintos y son datos personales (Ley 1581).
 *
 * ── El conjunto que sí se muestra ─────────────────────────────────────
 * Los comensales con una relación REAL con ESE restaurante. Hay tres
 * orígenes, y los tres salen de un hecho registrado — ninguno se infiere:
 *
 *   1. `orders`   consumió ahí (Order.customerId en ese restaurante)
 *   2. `discount` tiene un descuento pactado ahí (CustomerDiscount)
 *   3. `signup` / `added` — RestaurantCustomer: se registró desde la carta
 *      de ese restaurante, o el operador lo buscó por cédula/correo y lo
 *      agregó a mano.
 *
 * El caso que motivó el (3): alguien que se registra como comensal y
 * todavía no ha pedido nada era invisible para el local donde de hecho se
 * registró, así que el operador no podía habilitarle un descuento sin
 * saberse la cédula de memoria.
 */

import type { CustomerLinkSource } from "@prisma/client";
import { db } from "./db";

/**
 * Tope de filas de la lista. La pantalla no pagina todavía; para encontrar
 * a alguien que quede por fuera está el buscador exacto por cédula/correo.
 */
export const CUSTOMER_LIST_LIMIT = 200;

/** Por qué un comensal aparece en la lista de este restaurante. */
export type CustomerOrigin = "orders" | "discount" | CustomerLinkSource;

/**
 * Los `where` de las TRES consultas que arman la lista, en un solo lugar.
 *
 * Existe por la misma razón que `customerOrdersWhere` en monthRange.ts: el
 * `restaurantId` no puede ser opcional ni olvidable. Es un parámetro
 * obligatorio y sale SIEMPRE de la sesión (`getActiveRestaurantId` /
 * `requireOperatorScope`), nunca de la URL ni del body. Si alguien lo
 * quitara de cualquiera de las tres, el restaurante A vería comensales del
 * B — hay un test que falla si eso pasa.
 */
export function customerListWheres(restaurantId: string): {
  paidOrders: {
    restaurantId: string;
    customerId: { not: null };
    status: "paid";
  };
  discounts: { restaurantId: string };
  links: { restaurantId: string };
} {
  return {
    paidOrders: { restaurantId, customerId: { not: null }, status: "paid" },
    discounts: { restaurantId },
    links: { restaurantId },
  };
}

/** Una fila de la lista de clientes, ya resuelta. */
export type CustomerListRow = {
  id: string;
  name: string | null;
  email: string;
  cedula: string | null;
  /** Facturas pagadas EN ESTE restaurante. 0 es un valor legítimo. */
  orders: number;
  /** Total consumido EN ESTE restaurante, en centavos. */
  totalCents: number;
  /** Porcentaje del descuento vigente acá, o null. */
  discountPct: number | null;
  /** Por qué está en la lista. Nunca vacío. */
  origins: CustomerOrigin[];
};

/**
 * Une los tres orígenes en una sola lista ordenada.
 *
 * Pura (sin DB) para poder probarla: es acá donde se decide quién entra y
 * quién no, y esa decisión es la que sostiene el aislamiento entre
 * restaurantes. Las tres entradas ya vienen filtradas por restaurante desde
 * `customerListWheres`; esta función no vuelve a filtrar, solo cruza.
 *
 * Orden: primero lo que más ha consumido acá — es el orden que el operador
 * ya conocía. Los que todavía no han pedido nada (total 0) quedan al final
 * ordenados por nombre, para que la cola no sea aleatoria.
 */
export function buildCustomerRows(input: {
  /** Identidad de cada comensal. Los que falten se descartan. */
  users: {
    id: string;
    name: string | null;
    email: string;
    cedula: string | null;
  }[];
  /** Consumo facturado en este restaurante. */
  spend: { userId: string; orders: number; totalCents: number }[];
  /** Descuentos pactados en este restaurante (activos o apagados). */
  discounts: { userId: string; percent: number; active: boolean }[];
  /** Vínculos explícitos con este restaurante. */
  links: { userId: string; source: CustomerLinkSource }[];
}): CustomerListRow[] {
  const userById = new Map(input.users.map((u) => [u.id, u]));
  const rows = new Map<string, CustomerListRow>();

  const ensure = (userId: string): CustomerListRow | null => {
    const existing = rows.get(userId);
    if (existing) return existing;
    const u = userById.get(userId);
    // Sin identidad no hay fila: el usuario fue borrado, o quedó fuera del
    // lote que se pidió. Mejor omitirlo que pintar una fila fantasma.
    if (!u) return null;
    const row: CustomerListRow = {
      id: u.id,
      name: u.name,
      email: u.email,
      cedula: u.cedula,
      orders: 0,
      totalCents: 0,
      discountPct: null,
      origins: [],
    };
    rows.set(userId, row);
    return row;
  };

  const addOrigin = (row: CustomerListRow, origin: CustomerOrigin) => {
    if (!row.origins.includes(origin)) row.origins.push(origin);
  };

  for (const s of input.spend) {
    const row = ensure(s.userId);
    if (!row) continue;
    row.orders = s.orders;
    row.totalCents = s.totalCents;
    addOrigin(row, "orders");
  }

  for (const d of input.discounts) {
    const row = ensure(d.userId);
    if (!row) continue;
    // Un descuento apagado sigue siendo un vínculo: el restaurante ya
    // negoció con esa persona y quiere poder volver a prenderlo. Pero el
    // porcentaje solo se muestra si está vigente.
    if (d.active) row.discountPct = d.percent;
    addOrigin(row, "discount");
  }

  for (const l of input.links) {
    const row = ensure(l.userId);
    if (!row) continue;
    addOrigin(row, l.source);
  }

  return [...rows.values()].sort((a, b) => {
    if (b.totalCents !== a.totalCents) return b.totalCents - a.totalCents;
    const an = (a.name ?? a.email).toLocaleLowerCase();
    const bn = (b.name ?? b.email).toLocaleLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/**
 * Por qué (si es que por algo) este comensal está en la lista de ESTE
 * restaurante. Se usa para no ofrecer "agregar" a alguien que ya está, y
 * para decidir si "quitar de la lista" tiene efecto real.
 *
 * Las tres consultas llevan el `restaurantId` de la sesión. Un restaurante
 * no puede preguntar por el vínculo de otro.
 */
export async function getCustomerOrigins(
  restaurantId: string,
  userId: string,
): Promise<CustomerOrigin[]> {
  const wheres = customerListWheres(restaurantId);
  const [order, discount, link] = await Promise.all([
    db.order.findFirst({
      where: { ...wheres.paidOrders, customerId: userId },
      select: { id: true },
    }),
    db.customerDiscount.findUnique({
      where: { restaurantId_userId: { restaurantId, userId } },
      select: { id: true },
    }),
    db.restaurantCustomer.findUnique({
      where: { restaurantId_userId: { restaurantId, userId } },
      select: { source: true },
    }),
  ]);

  const origins: CustomerOrigin[] = [];
  if (order) origins.push("orders");
  if (discount) origins.push("discount");
  if (link) origins.push(link.source);
  return origins;
}

/**
 * Crea el vínculo "este comensal se registró desde este restaurante".
 *
 * Se llama desde el alta del comensal. Nunca revienta el registro: si el
 * slug no existe o la fila ya está, la cuenta igual se crea — el vínculo es
 * un extra, no un requisito para tener cuenta.
 *
 * Sin `slug` no hace nada: el comensal que se registró desde la home de
 * MESAPAY no le pertenece a ningún restaurante, y no se le inventa uno.
 */
export async function linkSignupRestaurant(
  userId: string,
  slug: string | null | undefined,
): Promise<void> {
  if (!slug) return;
  try {
    const restaurant = await db.restaurant.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!restaurant) return;
    await db.restaurantCustomer.upsert({
      where: {
        restaurantId_userId: { restaurantId: restaurant.id, userId },
      },
      create: { restaurantId: restaurant.id, userId, source: "signup" },
      update: {},
    });
  } catch {
    // El vínculo es accesorio: que falle no puede tumbar el registro.
  }
}
