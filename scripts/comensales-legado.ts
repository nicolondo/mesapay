/**
 * Reporte SOLO LECTURA de los comensales LEGADO: las filas de `User` con
 * `role=customer` que quedaron de cuando la identidad del comensal era
 * global, antes de que el registro pasara a ser por comercio.
 *
 * Por qué existe y por qué NO migra nada
 * ─────────────────────────────────────────────────────────────────────
 * Un `Diner` necesita un `restaurantId`, y estas filas no tienen ninguno:
 * `User.restaurantId` estaba en null para todos los comensales. Adivinar a
 * qué comercio pertenecen sería inventarle a un restaurante una base de
 * clientes que nunca tuvo. Así que no se migran: la persona vuelve a
 * registrarse en el restaurante donde come, que es un formulario de 30
 * segundos, y ahí sí su cuenta significa algo.
 *
 * Lo que este script hace es dejar el rastro para poder avisarles a mano:
 * lista quién era cada uno, qué evidencia hay (órdenes viejas, descuentos
 * que algún local le pactó) y en qué restaurante estuvo. Nada más.
 *
 * Uso:
 *   ./node_modules/.bin/tsx scripts/comensales-legado.ts
 *
 * No escribe. No borra. No crea.
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/**
 * ¿La columna vieja `Order.customerId` (FK a `User`) todavía existe?
 *
 * Es la única evidencia objetiva de en qué local comió cada uno de estos
 * usuarios. El deploy la reemplaza por `Order.dinerId`, así que después de
 * desplegar este script ya no la encuentra — y lo dice, en vez de fingir
 * que la persona nunca pidió nada.
 */
async function legacyOrderColumnExists(): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n
      FROM information_schema.columns
     WHERE table_name = 'Order' AND column_name = 'customerId'
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}

async function main() {
  const hasLegacyColumn = await legacyOrderColumnExists();
  const legacy = await db.user.findMany({
    where: { role: "customer" },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      restaurantId: true,
      disabledAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Comensales legado (User.role = customer): ${legacy.length}`);
  if (legacy.length === 0) {
    console.log("Nada que reportar.");
    return;
  }

  for (const u of legacy) {
    console.log("");
    console.log(`— ${u.name ?? "(sin nombre)"} <${u.email}>`);
    console.log(`  id=${u.id}  creado=${u.createdAt.toISOString().slice(0, 10)}`);
    console.log(`  restaurantId=${u.restaurantId ?? "null (nunca tuvo comercio)"}`);
    if (u.disabledAt) console.log(`  DESACTIVADO desde ${u.disabledAt.toISOString()}`);

    if (!hasLegacyColumn) {
      console.log(
        "  órdenes: la columna Order.customerId ya no existe (el deploy la reemplazó por dinerId) — sin evidencia",
      );
    } else {
      // Único rastro objetivo de en qué local estuvo: sus órdenes viejas.
      const orders = await db.$queryRawUnsafe<
        Array<{ restaurantId: string; slug: string; n: bigint }>
      >(
        `SELECT o."restaurantId", r.slug, COUNT(*) AS n
           FROM "Order" o
           JOIN "Restaurant" r ON r.id = o."restaurantId"
          WHERE o."customerId" = $1
          GROUP BY o."restaurantId", r.slug`,
        u.id,
      );
      if (orders.length === 0) {
        console.log(
          "  órdenes: ninguna → no hay forma de saber a qué comercio pertenecía",
        );
      } else {
        for (const o of orders) {
          console.log(`  órdenes: ${o.n} en ${o.slug} (${o.restaurantId})`);
        }
      }
    }
    console.log("  acción: avisarle que vuelva a registrarse desde el QR de su restaurante");
  }

  console.log("");
  console.log("Este script NO migró ni modificó nada. Es solo un reporte.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
