import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Borrado selectivo de datos operativos de un comercio (platform-admin).
 * Pensado para resetear un comercio (ej: salir de modo prueba / demo)
 * sin tener que recrearlo: borra mesas, cartas, menú, reseñas, facturas,
 * cierres, cobros, órdenes y/o el módulo de administración (ERP:
 * inventario, compras, recetas, producción, gastos, staff y DIAN) —
 * lo que el admin marque.
 *
 * IRREVERSIBLE. Por eso exigimos `confirmSlug` igual al slug del comercio
 * (el front pide tipearlo) y todo corre en una transacción: o se borra
 * todo lo seleccionado, o nada.
 *
 * Orden de borrado e implicaciones de FK (ver prisma/schema.prisma):
 *   - Order.table y OrderItem.menuItem son RESTRICT → no se puede borrar
 *     mesas/menú mientras existan órdenes que los referencian. Por eso
 *     borramos órdenes ANTES que menú/mesas, y si el admin pide borrar
 *     menú o mesas sin órdenes (habiendo órdenes), lo rechazamos.
 *   - Borrar una Order CASCADEA a rounds, order-items, payments, reseñas
 *     (DishRating), facturas (SimpleInvoice/InvoiceRequest). Así que pedir
 *     "órdenes" arrastra cobros/facturas/reseñas aunque no se marquen.
 *   - Shift→Payment es SetNull: borrar cierres NO borra cobros, sólo
 *     desvincula.
 *   - Menu→Category es SetNull (borrar "cartas" deja categorías sin menú).
 */
const schema = z.object({
  confirmSlug: z.string().trim().min(1),
  tables: z.boolean().optional().default(false),
  menus: z.boolean().optional().default(false), // "cartas" (modelo Menu)
  menu: z.boolean().optional().default(false), // categorías + platos
  reviews: z.boolean().optional().default(false),
  invoices: z.boolean().optional().default(false),
  shifts: z.boolean().optional().default(false),
  payments: z.boolean().optional().default(false),
  orders: z.boolean().optional().default(false),
  // Módulo de administración (ERP): inventario, compras, recetas,
  // producción, gastos, staff/horarios y facturación electrónica DIAN.
  erp: z.boolean().optional().default(false),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const sel = parsed.data;

  const restaurant = await db.restaurant.findUnique({
    where: { id },
    select: { id: true, slug: true, name: true },
  });
  if (!restaurant) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Confirmación: el slug tipeado debe coincidir. Defensa contra un
  // borrado accidental (un POST sin intención no trae el slug correcto).
  if (sel.confirmSlug !== restaurant.slug) {
    return NextResponse.json(
      { error: "confirm_mismatch", message: "El slug no coincide." },
      { status: 400 },
    );
  }

  const anySelected =
    sel.tables ||
    sel.menus ||
    sel.menu ||
    sel.reviews ||
    sel.invoices ||
    sel.shifts ||
    sel.payments ||
    sel.orders ||
    sel.erp;
  if (!anySelected) {
    return NextResponse.json(
      { error: "nothing_selected", message: "No seleccionaste nada." },
      { status: 400 },
    );
  }

  // FK guard: menú y mesas no se pueden borrar si quedan órdenes vivas
  // que los referencian (OrderItem.menuItem / Order.table son RESTRICT).
  if ((sel.menu || sel.tables) && !sel.orders) {
    const orderCount = await db.order.count({
      where: { restaurantId: id },
    });
    if (orderCount > 0) {
      return NextResponse.json(
        {
          error: "orders_block",
          message:
            "Para borrar Menú o Mesas también debes incluir Órdenes (hay órdenes que dependen de ellas).",
        },
        { status: 400 },
      );
    }
  }

  const counts: Record<string, number> = {};
  await db.$transaction(async (tx) => {
    // Hijos independientes primero; luego órdenes (cascadea el resto);
    // luego menú/cartas/mesas (ya sin referencias de órdenes).
    if (sel.reviews) {
      counts.reviews = (
        await tx.dishRating.deleteMany({ where: { restaurantId: id } })
      ).count;
    }
    if (sel.invoices) {
      const inv = await tx.simpleInvoice.deleteMany({
        where: { restaurantId: id },
      });
      const reqs = await tx.invoiceRequest.deleteMany({
        where: { restaurantId: id },
      });
      counts.invoices = inv.count + reqs.count;
    }
    if (sel.payments) {
      counts.payments = (
        await tx.payment.deleteMany({ where: { order: { restaurantId: id } } })
      ).count;
    }
    if (sel.shifts) {
      // Egresos/ingresos de caja viven en el dominio de cierres/caja.
      await tx.cashMovement.deleteMany({ where: { restaurantId: id } });
      counts.shifts = (
        await tx.shift.deleteMany({ where: { restaurantId: id } })
      ).count;
    }
    if (sel.erp) {
      // Módulo de administración (ERP). Orden FK-safe: primero las hojas
      // del libro (movimientos, conteos, saldos), luego compras (OCs
      // cascadean sus ítems), recetas (cascadean sus ítems), producción y
      // lista de precios (cascadea el historial), luego gastos, y recién
      // ahí el catálogo (insumos/proveedores, ya libres de los RESTRICT de
      // OC-items/recetas/batches/precios), staff y DIAN. Va antes que
      // órdenes/menú para no arrastrar SetNull/cascadas innecesarias.
      let n = 0;
      n += (await tx.stockMovement.deleteMany({ where: { restaurantId: id } })).count;
      n += (await tx.stockCount.deleteMany({ where: { restaurantId: id } })).count; // cascadea StockCountItem
      n += (await tx.stockLevel.deleteMany({ where: { restaurantId: id } })).count;
      n += (await tx.purchaseInvoiceUpload.deleteMany({ where: { restaurantId: id } })).count;
      n += (await tx.purchaseOrder.deleteMany({ where: { restaurantId: id } })).count; // cascadea PurchaseOrderItem
      n += (await tx.recipe.deleteMany({ where: { restaurantId: id } })).count; // cascadea RecipeItem
      n += (await tx.productionBatch.deleteMany({ where: { restaurantId: id } })).count;
      n += (await tx.supplierIngredient.deleteMany({ where: { supplier: { restaurantId: id } } })).count; // cascadea SupplierPriceHistory
      n += (await tx.expense.deleteMany({ where: { restaurantId: id } })).count;
      n += (await tx.ingredient.deleteMany({ where: { restaurantId: id } })).count;
      n += (await tx.supplier.deleteMany({ where: { restaurantId: id } })).count;
      n += (await tx.staffShift.deleteMany({ where: { restaurantId: id } })).count;
      n += (await tx.employee.deleteMany({ where: { restaurantId: id } })).count;
      n += (await tx.dianDocument.deleteMany({ where: { restaurantId: id } })).count;
      n += (await tx.dianConfig.deleteMany({ where: { restaurantId: id } })).count;
      counts.erp = n;
    }
    if (sel.orders) {
      // Cascadea rounds, order-items, cobros, reseñas y facturas restantes.
      counts.orders = (
        await tx.order.deleteMany({ where: { restaurantId: id } })
      ).count;
    }
    if (sel.menu) {
      const items = await tx.menuItem.deleteMany({
        where: { restaurantId: id },
      });
      const cats = await tx.category.deleteMany({
        where: { restaurantId: id },
      });
      counts.menu = items.count + cats.count;
    }
    if (sel.menus) {
      counts.menus = (
        await tx.menu.deleteMany({ where: { restaurantId: id } })
      ).count;
    }
    if (sel.tables) {
      counts.tables = (
        await tx.table.deleteMany({ where: { restaurantId: id } })
      ).count;
    }
  });

  const picked = Object.entries(counts)
    .map(([k, n]) => `${k}:${n}`)
    .join(", ");
  await recordAuditEvent({
    kind: "restaurant.data.reset",
    restaurantId: id,
    target: { type: "restaurant", id },
    summary: `Borró datos de ${restaurant.name} (${picked || "nada"})`,
    diff: { after: counts },
  });

  return NextResponse.json({ ok: true, counts });
}
