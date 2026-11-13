import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient, type Ingredient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

// Conteo físico compacto: una línea por insumo, lo último contado arriba,
// barras fijas, corrección de códigos y alta de insumos sin salir del conteo.
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["127.0.0.1", "localhost"].includes(database.hostname)
    || !/^\/mesapay_.*validation$/.test(database.pathname)
    || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "An isolated local app and validation database are required",
);
const db = new PrismaClient();

type Seed = { name: string; category?: string | null; barcode?: string | null; active?: boolean; trackInventory?: boolean; measureKind?: "count" | "mass" | "volume"; qty?: number };
async function fixture(items: Seed[], options: { excluded?: string[] } = {}) {
  const token = randomUUID();
  const password = `Compact-${token}`;
  const restaurant = await db.restaurant.create({ data: {
    name: "Conteo compacto QA", slug: `count-compact-${token}`, enabledModules: ["inventory"], inventoryExcludedCategories: options.excluded ?? [],
  } });
  const user = await db.user.create({ data: {
    email: `count-compact-${token}@example.test`, passwordHash: await bcrypt.hash(password, 10), role: "operator", restaurantId: restaurant.id,
  } });
  const ingredients: Record<string, Ingredient> = {};
  for (const item of items) {
    ingredients[item.name] = await db.ingredient.create({ data: {
      restaurantId: restaurant.id, name: item.name, category: item.category ?? null, measureKind: item.measureKind ?? "count",
      barcode: item.barcode ?? null, active: item.active ?? true, trackInventory: item.trackInventory ?? true,
      ...(item.qty === undefined ? {} : { stockLevel: { create: { restaurantId: restaurant.id, qtyBase: item.qty, totalValueCents: item.qty * 10 } } }),
    } });
  }
  return {
    restaurant, user, password, ingredients,
    cleanup: async () => {
      await db.auditEvent.deleteMany({ where: { restaurantId: restaurant.id } });
      await db.restaurant.delete({ where: { id: restaurant.id } });
      await db.user.deleteMany({ where: { id: user.id } });
    },
  };
}

async function login(page: Page, seed: Awaited<ReturnType<typeof fixture>>) {
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/session") && response.ok()),
    page.goto("/signin"),
  ]);
  await page.getByLabel("Correo", { exact: true }).fill(seed.user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(seed.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/operator");
}

async function createCount(page: Page, category?: string) {
  await page.goto("/operator/inventario?tab=conteos");
  await page.getByRole("button", { name: "Nuevo conteo", exact: true }).click();
  if (category) await page.getByRole("dialog", { name: "Nuevo conteo físico", exact: true }).locator("select").selectOption(category);
  await page.getByRole("button", { name: "Crear conteo", exact: true }).click();
  const scanner = page.getByLabel("Escanear código de barras", { exact: true });
  await expect(scanner).toBeFocused();
  return scanner;
}

const sheet = (page: Page) => page.getByRole("dialog", { name: "Conteo físico", exact: true });
const rows = (page: Page) => page.locator("[data-count-row]");
const quantity = (page: Page, name: string, part = 1) => page.getByLabel(part === 1 ? `Conteo de ${name}` : `Cantidad ${part} de ${name}`, { exact: true });
const search = (page: Page) => page.getByLabel("Buscar insumo en el conteo…", { exact: true });
const names = async (page: Page, count: number) => (await rows(page).locator(".mp-tally-name__text").allTextContents()).slice(0, count);

/** Lector HID: una ráfaga de teclas y Enter. */
async function scan(page: Page, scanner: Locator, barcode: string) {
  await scanner.focus();
  await page.keyboard.type(barcode, { delay: 2 });
  await page.keyboard.press("Enter");
  await expect(scanner).toHaveValue("");
}
async function count(page: Page, scanner: Locator, barcode: string, name: string, amount: string, part = 1) {
  await scan(page, scanner, barcode);
  await expect(quantity(page, name, part)).toBeFocused();
  await page.keyboard.type(amount);
  await page.keyboard.press("Enter");
  await expect(scanner).toBeFocused();
}

test("one line per item, most recent first, typing never reorders and the bars stay in place", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const seed = await fixture(Array.from({ length: 55 }, (_, index) => ({
    name: `Insumo ${String(index).padStart(2, "0")}`, category: index % 2 ? "Abarrotes" : "Licores", barcode: `CMP-${String(index).padStart(3, "0")}`, qty: 10_000,
    // Uno por peso: su unidad (g/kg) se puede cambiar, así que el foco puede moverse dentro de la fila.
    measureKind: index === 30 ? "mass" as const : "count" as const,
  })));
  try {
    await login(page, seed);
    const scanner = await createCount(page);
    const desktop = page.viewportSize()!.width >= 768;
    const region = page.getByRole("region", { name: "Detalle del conteo", exact: true });
    await expect(rows(page)).toHaveCount(55);

    // Una línea por insumo (dos en el celular): antes cada insumo ocupaba ~480 px.
    for (const index of [0, 1, 30]) {
      const height = (await rows(page).nth(index).boundingBox())!.height;
      expect(height, `fila ${index}`).toBeLessThanOrEqual(desktop ? 48 : 92);
    }
    // La barra de escaneo y el buscador comparten una sola línea.
    const scanBox = (await scanner.boundingBox())!;
    const searchBox = (await search(page).boundingBox())!;
    expect(Math.abs(scanBox.y - searchBox.y)).toBeLessThan(4);
    expect(searchBox.x).toBeGreaterThan(scanBox.x + scanBox.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("01-abierto.png") });

    // Lo último escaneado queda arriba; el resto conserva su orden.
    await count(page, scanner, "CMP-040", "Insumo 40", "12");
    await count(page, scanner, "CMP-012", "Insumo 12", "3");
    await count(page, scanner, "CMP-051", "Insumo 51", "7");
    await expect(page.getByRole("heading", { name: "Contados recientemente 3", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Los demás insumos 52", exact: true })).toBeAttached();
    expect(await names(page, 5)).toEqual(["Insumo 51", "Insumo 12", "Insumo 40", "Insumo 00", "Insumo 01"]);
    await count(page, scanner, "CMP-012", "Insumo 12", "4", 2);
    expect(await names(page, 4)).toEqual(["Insumo 12", "Insumo 51", "Insumo 40", "Insumo 00"]);
    await expect(rows(page).first().getByRole("button", { name: /^2 cantidades de Insumo 12/ })).toBeVisible();
    await expect(rows(page).first().getByRole("status", { name: "Total contado de Insumo 12", exact: true })).toContainText("7 un");
    expect(await region.evaluate((element) => element.scrollTop)).toBe(0);

    // Escribir en una fila de más abajo NO la mueve; sube al soltarla.
    const typed = quantity(page, "Insumo 30");
    await typed.scrollIntoViewIfNeeded();
    await typed.click();
    const before = await names(page, 55);
    const neighbour = rows(page).filter({ hasText: "Insumo 31" });
    const neighbourTop = (await neighbour.boundingBox())!.y;
    for (const digit of "125") {
      await page.keyboard.type(digit);
      await expect(typed).toBeFocused();
      expect(await names(page, 55)).toEqual(before);
    }
    await expect(typed).toHaveValue("125");
    // Pasar a la unidad de la MISMA fila no es soltarla: sigue sin moverse.
    await page.getByLabel("Unidad de Insumo 30", { exact: true }).focus();
    await expect(page.getByLabel("Unidad de Insumo 30", { exact: true })).toBeFocused();
    expect(await names(page, 55)).toEqual(before);
    // Al pasar a la fila siguiente, la editada sube a «recientes» y lo que se está mirando no salta.
    await quantity(page, "Insumo 31").click();
    await expect(quantity(page, "Insumo 31")).toBeFocused();
    await expect.poll(() => names(page, 4)).toEqual(["Insumo 30", "Insumo 12", "Insumo 51", "Insumo 40"]);
    expect(Math.abs((await neighbour.boundingBox())!.y - neighbourTop)).toBeLessThan(3);
    await expect(typed).toHaveValue("125");

    // Las barras siguen a la vista con la lista a la mitad y al final.
    for (const ratio of [0.5, 1]) {
      await region.evaluate((element, value) => { element.scrollTop = element.scrollHeight * value; }, ratio);
      await expect(scanner).toBeInViewport({ ratio: 1 });
      await expect(search(page)).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("button", { name: /^Pendientes \d+$/ })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("button", { name: "Guardar borrador", exact: true })).toBeInViewport({ ratio: 1 });
      expect(Math.abs((await scanner.boundingBox())!.y - scanBox.y)).toBeLessThan(3);
    }
    await page.screenshot({ path: testInfo.outputPath("02-lista-al-final.png") });

    // Un escaneo con la lista abajo la devuelve arriba, donde quedó el insumo.
    await scan(page, scanner, "CMP-005");
    await expect(quantity(page, "Insumo 05")).toBeFocused();
    await expect(quantity(page, "Insumo 05")).toBeInViewport({ ratio: 1 });
    expect(await region.evaluate((element) => element.scrollTop)).toBe(0);
    await page.keyboard.type("9");
    await page.keyboard.press("Enter");

    // El buscador encuentra por código de barras y por nombre, y los filtros siguen sirviendo.
    await search(page).fill("CMP-044");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("Insumo 44");
    await search(page).fill("insumo 1");
    await expect(rows(page)).toHaveCount(10);
    expect(await names(page, 2)).toEqual(["Insumo 12", "Insumo 10"]);
    await search(page).fill("");
    // Los filtros muestran lo mismo que dicen sus contadores, con lo digitado (aún sin guardar).
    await page.getByRole("button", { name: "Sobrantes 2", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sobrantes 2", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await names(page, 5)).toEqual(["Insumo 30", "Insumo 40"]);
    await page.getByRole("button", { name: "Faltantes 3", exact: true }).click();
    expect(await names(page, 5)).toEqual(["Insumo 05", "Insumo 12", "Insumo 51"]);
    await page.getByRole("button", { name: "Pendientes 50", exact: true }).click();
    await expect(rows(page)).toHaveCount(50);
    // En «Pendientes», la fila en la que se escribe no se va hasta soltarla.
    const pending = quantity(page, "Insumo 00");
    await pending.click();
    await page.keyboard.type("10");
    await expect(pending).toBeFocused();
    await expect(rows(page)).toHaveCount(50);
    await quantity(page, "Insumo 01").click();
    await expect(rows(page)).toHaveCount(49);
    await expect(page.getByRole("button", { name: "Pendientes 49", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Todos \d+$/ }).click();
    await expect(rows(page)).toHaveCount(55);
    expect(await names(page, 2)).toEqual(["Insumo 00", "Insumo 05"]);
    await page.screenshot({ path: testInfo.outputPath("03-recientes.png") });

    // Nada se guardó todavía; al guardar se cierra y, al reabrir, lo último contado sigue arriba.
    const session = await db.stockCount.findFirstOrThrow({ where: { restaurantId: seed.restaurant.id } });
    expect(await db.stockCountItem.count({ where: { countId: session.id, countedQty: { not: null } } })).toBe(0);
    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Borrador guardado." })).toBeVisible();
    expect(await db.stockCountItem.count({ where: { countId: session.id, countedQty: { not: null } } })).toBe(6);
    expect((await db.stockCountItem.findFirstOrThrow({ where: { countId: session.id, ingredientId: seed.ingredients["Insumo 12"].id } }))).toMatchObject({ countedQty: 7000, countedParts: [3000, 4000] });
    await page.locator("#inv-panel-counts").getByRole("button", { name: /Abrir el conteo|55 insumos/ }).filter({ visible: true }).first().click();
    await expect(scanner).toBeFocused();
    expect(await names(page, 7)).toEqual(["Insumo 00", "Insumo 05", "Insumo 30", "Insumo 12", "Insumo 51", "Insumo 40", "Insumo 01"]);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);
  } finally { await seed.cleanup(); }
});

test("a code owned by an item outside the count is explained and can be moved, restored or added", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  page.on("dialog", (dialog) => dialog.accept());
  const seed = await fixture([
    { name: "Ron añejo", category: "Licores", barcode: "RON-1", qty: 5000 },
    { name: "Vino blanco", category: "Licores", qty: 3000 },
    { name: "Gin", category: "Licores", barcode: "GIN-1", qty: 2000 },
    // El caso real: el código lo tiene un duplicado ARCHIVADO que aún guarda existencias.
    { name: "Vino blanco (viejo)", category: "Licores", barcode: "7804436720807", active: false, qty: 6000 },
    { name: "Vodka archivado", category: "Licores", barcode: "VODKA-OLD", active: false, qty: 4000 },
    { name: "Servilletas", category: "Aseo", barcode: "ASEO-1", qty: 100_000 },
    { name: "Flete", category: "Servicios", barcode: "SVC-1", trackInventory: false },
    { name: "Arroz", category: "Abarrotes", barcode: "RICE-1", qty: 9000 },
  ], { excluded: ["Aseo"] });
  const id = (name: string) => seed.ingredients[name].id;
  const owner = async (barcode: string) => (await db.ingredientBarcode.findUnique({ where: { restaurantId_barcode: { restaurantId: seed.restaurant.id, barcode } } }))?.ingredientId;
  try {
    await login(page, seed);
    const scanner = await createCount(page, "Licores");
    await expect(rows(page)).toHaveCount(3);
    await quantity(page, "Gin").fill("2");
    const note = sheet(page).getByRole("alert");

    // 1) Archivado → dice cuál es y por qué no aparece; se le pasa el código al insumo activo y se cuenta.
    await scan(page, scanner, "7804436720807");
    await expect(note).toContainText("El código 7804436720807 es de «Vino blanco (viejo)», que está archivado: por eso no aparece en este conteo.");
    await expect(page.getByRole("button", { name: "Restaurar «Vino blanco (viejo)» y contarlo", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("01-codigo-de-archivado.png") });
    await page.getByRole("button", { name: "Pasar el código a otro insumo", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Pasar el código a otro insumo", exact: true });
    await expect(picker).toContainText("«Vino blanco (viejo)» deja de tenerlo");
    await picker.getByRole("searchbox").fill("vino");
    await picker.getByRole("button", { name: /^Vino blanco/ }).click();
    await expect(picker).toHaveCount(0);
    await expect(quantity(page, "Vino blanco")).toBeFocused();
    expect(await names(page, 1)).toEqual(["Vino blanco"]);
    await expect(sheet(page).getByText("El código 7804436720807 quedó en «Vino blanco».", { exact: true })).toBeVisible();
    expect(await owner("7804436720807")).toBe(id("Vino blanco"));
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: id("Vino blanco (viejo)") } })).toMatchObject({ barcode: null, active: false });
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: id("Vino blanco") } })).toMatchObject({ barcode: "7804436720807" });
    expect(await db.auditEvent.count({ where: { restaurantId: seed.restaurant.id, kind: "ingredient.barcode.move", targetId: id("Vino blanco") } })).toBe(1);
    await page.keyboard.type("5");
    await page.keyboard.press("Enter");
    await expect(scanner).toBeFocused();
    // Lo digitado antes sigue ahí, y el código ya lleva directo al insumo.
    await expect(quantity(page, "Gin")).toHaveValue("2");
    await scan(page, scanner, "7804436720807");
    await expect(quantity(page, "Vino blanco", 2)).toBeFocused();

    // 2) Archivado → restaurarlo: vuelve a estar activo y entra a este conteo con su existencia.
    await scan(page, scanner, "VODKA-OLD");
    await page.getByRole("button", { name: "Restaurar «Vodka archivado» y contarlo", exact: true }).click();
    await expect(quantity(page, "Vodka archivado")).toBeFocused();
    await expect(rows(page)).toHaveCount(4);
    await expect(sheet(page).getByText("Se restauró «Vodka archivado» y ya está en este conteo. Escribe su cantidad.", { exact: true })).toBeVisible();
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: id("Vodka archivado") } })).active).toBe(true);
    const session = await db.stockCount.findFirstOrThrow({ where: { restaurantId: seed.restaurant.id } });
    expect(await db.stockCountItem.findFirstOrThrow({ where: { countId: session.id, ingredientId: id("Vodka archivado") } })).toMatchObject({ expectedQty: 4000, countedQty: null });
    await page.keyboard.type("4");
    await page.keyboard.press("Enter");

    // 3) Categoría que no maneja inventario / insumo sin inventario: se explica y solo se ofrece pasar el código.
    await scan(page, scanner, "ASEO-1");
    await expect(note).toContainText("El código ASEO-1 es de «Servilletas», de la categoría «Aseo», que no maneja inventario.");
    await expect(page.getByRole("button", { name: /^Agregar «/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pasar el código a otro insumo", exact: true })).toBeVisible();
    await scan(page, scanner, "SVC-1");
    await expect(note).toContainText("El código SVC-1 es de «Flete», que no lleva inventario: por eso no entra en los conteos.");
    await expect(page.getByRole("button", { name: /^(Agregar|Restaurar) «/ })).toHaveCount(0);

    // 4) Otra categoría que la del conteo: se dice, y se puede agregar de todos modos.
    await scan(page, scanner, "RICE-1");
    await expect(note).toContainText("El código RICE-1 es de «Arroz» (Abarrotes). No está en este conteo porque se abrió solo para «Licores».");
    await page.screenshot({ path: testInfo.outputPath("02-otra-categoria.png") });
    await page.getByRole("button", { name: "Agregar «Arroz» al conteo", exact: true }).click();
    await expect(quantity(page, "Arroz")).toBeFocused();
    await expect(sheet(page).getByText(/«Arroz» quedó en este conteo aunque no es de «Licores»/)).toBeVisible();
    await page.keyboard.type("9");
    await page.keyboard.press("Enter");
    await expect(rows(page)).toHaveCount(5);

    // Todo lo digitado sobrevivió a las altas y se guarda de una vez.
    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect(sheet(page)).toHaveCount(0);
    const saved = await db.stockCountItem.findMany({ where: { countId: session.id } });
    const counted = (name: string) => saved.find((item) => item.ingredientId === id(name))?.countedQty;
    expect([counted("Gin"), counted("Vino blanco"), counted("Vodka archivado"), counted("Arroz"), counted("Ron añejo")]).toEqual([2000, 5000, 4000, 9000, null]);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await seed.cleanup(); }
});

test("a wrong link can be undone, corrected or edited, and a taken code is handed over in one step", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  page.on("dialog", (dialog) => dialog.accept());
  const seed = await fixture([
    { name: "Agua", category: "Bebidas", barcode: "AGUA-1", qty: 1000 },
    { name: "Arroz", category: "Abarrotes", qty: 1000 },
    { name: "Azúcar", category: "Abarrotes", barcode: "AZU-1", qty: 1000 },
    { name: "Panela vieja", category: "Abarrotes", barcode: "PANELA-OLD", active: false, qty: 500 },
  ]);
  const id = (name: string) => seed.ingredients[name].id;
  const codes = async (name: string) => (await db.ingredientBarcode.findMany({ where: { ingredientId: id(name) }, orderBy: { barcode: "asc" } })).map((row) => row.barcode);
  try {
    await login(page, seed);
    const scanner = await createCount(page);
    await quantity(page, "Agua").fill("12");

    // Código sin dueño → se vincula al insumo equivocado, se deshace y se vincula bien.
    await scan(page, scanner, "NEW-900");
    await expect(sheet(page).getByRole("alert")).toContainText("El código NEW-900 no está en ningún insumo.");
    await page.getByRole("button", { name: "Vincular a un insumo", exact: true }).click();
    let picker = page.getByRole("dialog", { name: "Vincular a un insumo", exact: true });
    await picker.getByRole("button", { name: /^Azúcar/ }).click();
    await expect(quantity(page, "Azúcar")).toBeFocused();
    expect(await codes("Azúcar")).toEqual(["AZU-1", "NEW-900"]);
    await page.screenshot({ path: testInfo.outputPath("01-deshacer-corregir.png") });
    await page.getByRole("button", { name: "Deshacer", exact: true }).click();
    await expect(sheet(page).getByRole("alert")).toContainText("El código NEW-900 no está en ningún insumo.");
    expect(await codes("Azúcar")).toEqual(["AZU-1"]);

    // …otra vez al equivocado, y ahora «Corregir» lo pasa al que era.
    await page.getByRole("button", { name: "Vincular a un insumo", exact: true }).click();
    picker = page.getByRole("dialog", { name: "Vincular a un insumo", exact: true });
    await picker.getByRole("button", { name: /^Azúcar/ }).click();
    await expect(quantity(page, "Azúcar")).toBeFocused();
    await page.getByRole("button", { name: "Corregir", exact: true }).click();
    picker = page.getByRole("dialog", { name: "Pasar el código a otro insumo", exact: true });
    await expect(picker.getByRole("button", { name: /^Azúcar/ })).toHaveCount(0);
    await picker.getByRole("button", { name: /^Arroz/ }).click();
    await expect(quantity(page, "Arroz")).toBeFocused();
    await expect(sheet(page).getByText("El código NEW-900 quedó en «Arroz».", { exact: true })).toBeVisible();
    expect(await codes("Azúcar")).toEqual(["AZU-1"]);
    expect(await codes("Arroz")).toEqual(["NEW-900"]);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: id("Arroz") } })).barcode).toBe("NEW-900");
    await page.keyboard.type("7");
    await page.keyboard.press("Enter");

    // Más tarde, desde la fila: editar el valor de un código mal digitado.
    await page.getByRole("button", { name: "Códigos de barras de Arroz", exact: true }).click();
    const sheetCodes = page.getByRole("dialog", { name: "Códigos de barras", exact: true });
    await sheetCodes.getByRole("button", { name: "Editar el código NEW-900", exact: true }).click();
    const edit = sheetCodes.getByRole("textbox", { name: "Nuevo valor del código NEW-900", exact: true });
    await expect(edit).toHaveValue("NEW-900");
    await edit.fill("AZU-1");
    await edit.press("Enter");
    // No pisa el código de otro insumo: dice de quién es.
    await expect(sheetCodes.getByRole("alert")).toContainText("«Azúcar»");
    await edit.fill(" NEW 901\t");
    await edit.press("Enter");
    await expect(sheetCodes.getByRole("status")).toHaveText("Código corregido");
    await expect(sheetCodes).toContainText("NEW901");
    expect(await codes("Arroz")).toEqual(["NEW901"]);
    await page.screenshot({ path: testInfo.outputPath("02-hoja-de-codigos.png") });

    // Desde la misma hoja: agregar un código que ya tiene OTRO insumo (archivado) → «Pasárselo a este insumo».
    const add = sheetCodes.getByRole("textbox", { name: "Código de barras de Arroz", exact: true });
    await add.fill("PANELA-OLD");
    await add.press("Enter");
    await expect(sheetCodes.getByRole("alert")).toContainText("Este código ya lo tiene «Panela vieja», que está archivado.");
    await sheetCodes.getByRole("button", { name: "Pasárselo a este insumo", exact: true }).click();
    await expect(sheetCodes.getByRole("status")).toContainText("el código pasó de «Panela vieja» a este insumo");
    expect(await codes("Arroz")).toEqual(["NEW901", "PANELA-OLD"]);
    expect(await codes("Panela vieja")).toEqual([]);

    // …y pasar uno de sus códigos a otro insumo del conteo.
    await sheetCodes.getByRole("button", { name: "Pasar el código PANELA-OLD a otro insumo", exact: true }).click();
    await sheetCodes.getByRole("searchbox").fill("agua");
    await sheetCodes.getByRole("button", { name: /^Agua/ }).click();
    await expect(sheetCodes.getByRole("status")).toHaveText("Código pasado a «Agua»");
    expect(await codes("Agua")).toEqual(["AGUA-1", "PANELA-OLD"]);
    await sheetCodes.getByRole("button", { name: "Cerrar", exact: true }).click();
    await expect(sheetCodes).toHaveCount(0);

    // Las cantidades digitadas sobrevivieron a todo, y los códigos ya resuelven al insumo correcto.
    await expect(quantity(page, "Agua")).toHaveValue("12");
    await expect(quantity(page, "Arroz")).toHaveValue("7");
    await scan(page, scanner, "PANELA-OLD");
    await expect(quantity(page, "Agua", 2)).toBeFocused();
    await scan(page, scanner, "NEW901");
    await expect(quantity(page, "Arroz", 2)).toBeFocused();
    await scan(page, scanner, "NEW-900");
    await expect(sheet(page).getByRole("alert")).toContainText("El código NEW-900 no está en ningún insumo.");
    const kinds = (await db.auditEvent.findMany({ where: { restaurantId: seed.restaurant.id }, orderBy: { occurredAt: "asc" } })).map((event) => event.kind);
    expect(kinds).toEqual([
      "ingredient.barcode.add", "ingredient.barcode.remove", "ingredient.barcode.add", "ingredient.barcode.move",
      "ingredient.barcode.replace", "ingredient.barcode.move", "ingredient.barcode.move",
    ]);
    const session = await db.stockCount.findFirstOrThrow({ where: { restaurantId: seed.restaurant.id } });
    expect(await db.stockCountItem.count({ where: { countId: session.id, countedQty: { not: null } } })).toBe(0);

    // Existencias: la misma hoja ofrece el traspaso al agregar un código ocupado.
    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect(sheet(page)).toHaveCount(0);
    await page.getByRole("tab", { name: "Existencias", exact: true }).click();
    await page.getByRole("button", { name: "Acciones de Azúcar", exact: true }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "Códigos de barras", exact: true }).click();
    const stockCodes = page.getByRole("dialog", { name: "Códigos de barras", exact: true });
    await stockCodes.getByRole("textbox", { name: "Código de barras de Azúcar", exact: true }).fill("AGUA-1");
    await stockCodes.getByRole("button", { name: "Guardar código", exact: true }).click();
    await expect(stockCodes.getByRole("alert")).toContainText("Este código ya lo tiene «Agua».");
    await stockCodes.getByRole("button", { name: "Pasárselo a este insumo", exact: true }).click();
    await expect(stockCodes.getByRole("status")).toContainText("el código pasó de «Agua» a este insumo");
    expect(await codes("Azúcar")).toEqual(["AGUA-1", "AZU-1"]);
    // Era el principal de Agua: asciende el que le quedaba.
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: id("Agua") } })).barcode).toBe("PANELA-OLD");
  } finally { await seed.cleanup(); }
});

test("a new ingredient is created from the count, counted right away and closed as a surplus from zero", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  page.on("dialog", (dialog) => dialog.accept());
  const seed = await fixture([
    { name: "Aceite", category: "Abarrotes", barcode: "ACE-1", qty: 5000, measureKind: "volume" },
    { name: "Sal", category: "Abarrotes", barcode: "SAL-1", qty: 2000, measureKind: "mass" },
    { name: "Comino viejo", category: "Abarrotes", active: false, qty: 300, measureKind: "mass" },
  ]);
  const created = (name: string) => db.ingredient.findFirstOrThrow({ where: { restaurantId: seed.restaurant.id, name }, include: { stockLevel: true, barcodes: true } });
  try {
    await login(page, seed);
    const scanner = await createCount(page);
    await quantity(page, "Sal").fill("1,5");
    const dialog = page.getByRole("dialog", { name: "Nuevo insumo", exact: true });
    const fields = { name: dialog.getByLabel(/^Nombre/), measure: dialog.getByLabel(/^Dimensión de medida/), category: dialog.getByLabel(/^Categoría/), barcode: dialog.getByLabel(/^Código de barras/) };

    // (a) Código que no es de nadie → «Crear insumo con este código», con el código ya escrito.
    await scan(page, scanner, "PIM-777");
    await page.getByRole("button", { name: "Crear insumo con este código", exact: true }).click();
    await expect(fields.barcode).toHaveValue("PIM-777");
    await expect(dialog).toContainText("entra a este conteo con existencia 0");
    await fields.name.fill("Pimienta negra");
    await fields.measure.selectOption({ label: "Unidades — un" });
    await fields.category.fill("Abarrotes");
    await page.screenshot({ path: testInfo.outputPath("01-nuevo-insumo.png") });
    await dialog.getByRole("button", { name: "Crear", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // Entra al conteo, arriba de todo, con la cantidad lista.
    await expect(quantity(page, "Pimienta negra")).toBeFocused();
    expect(await names(page, 1)).toEqual(["Pimienta negra"]);
    await expect(rows(page)).toHaveCount(3);
    await page.keyboard.type("6");
    await page.keyboard.press("Enter");
    await expect(scanner).toBeFocused();
    const pepper = await created("Pimienta negra");
    expect(pepper).toMatchObject({ barcode: "PIM-777", category: "Abarrotes", measureKind: "count", active: true, trackInventory: true, stockLevel: null });
    const session = await db.stockCount.findFirstOrThrow({ where: { restaurantId: seed.restaurant.id } });
    expect(await db.stockCountItem.findFirstOrThrow({ where: { countId: session.id, ingredientId: pepper.id } })).toMatchObject({ expectedQty: 0, countedQty: null });
    // Lo que se llevaba digitado sigue ahí, y el código nuevo ya salta a su insumo.
    await expect(quantity(page, "Sal")).toHaveValue("1,5");
    await scan(page, scanner, "PIM-777");
    await expect(quantity(page, "Pimienta negra", 2)).toBeFocused();

    // (b) Buscador sin resultados → «Crear «texto»», con el nombre ya escrito.
    await search(page).fill("Laurel");
    await expect(rows(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Crear «Laurel»", exact: true }).click();
    await expect(fields.name).toHaveValue("Laurel");
    await fields.measure.selectOption({ label: "Peso — g/kg" });
    await dialog.getByRole("button", { name: "Crear", exact: true }).click();
    await expect(quantity(page, "Laurel")).toBeFocused();
    await expect(search(page)).toHaveValue("");
    await page.keyboard.type("0,25");
    await page.keyboard.press("Enter");

    // (c) «Nuevo insumo» en la barra; un nombre que ya existe (archivado) ofrece restaurarlo.
    await sheet(page).getByRole("button", { name: "Nuevo insumo", exact: true }).click();
    await fields.name.fill("Comino viejo");
    await dialog.getByRole("button", { name: "Crear", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Ya existe «Comino viejo», pero está archivado.");
    await dialog.getByRole("button", { name: "Restaurar «Comino viejo» y contarlo", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(quantity(page, "Comino viejo")).toBeFocused();
    await page.keyboard.type("0,3");
    await page.keyboard.press("Enter");
    // …y un código que ya tiene otro insumo del conteo ofrece ir a él.
    await sheet(page).getByRole("button", { name: "Nuevo insumo", exact: true }).click();
    await fields.name.fill("Aceite de girasol");
    await fields.barcode.fill("ACE-1");
    await dialog.getByRole("button", { name: "Crear", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Ese código de barras ya lo tiene «Aceite».");
    await dialog.getByRole("button", { name: "Ir a «Aceite» en el conteo", exact: true }).click();
    await expect(quantity(page, "Aceite")).toBeFocused();
    await page.keyboard.type("5000");
    await page.keyboard.press("Enter");
    expect(await db.ingredient.count({ where: { restaurantId: seed.restaurant.id, name: "Aceite de girasol" } })).toBe(0);
    await expect(rows(page)).toHaveCount(5);
    expect(await names(page, 5)).toEqual(["Aceite", "Comino viejo", "Laurel", "Pimienta negra", "Sal"]);
    await page.screenshot({ path: testInfo.outputPath("02-insumos-nuevos-contados.png") });
    expect(await db.stockCountItem.count({ where: { countId: session.id, countedQty: { not: null } } })).toBe(0);

    // Preliminar → definitivo → cierre: el insumo nuevo entra como sobrante desde cero.
    await page.getByRole("button", { name: "Ver preliminar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true })).toBeVisible();
    await expect(sheet(page).getByRole("button", { name: "Nuevo insumo", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true }).click();
    await expect(scanner).toBeFocused();
    for (const [name, amount] of [["Aceite", "5000"], ["Comino viejo", "0,3"], ["Laurel", "0,25"], ["Pimienta negra", "6"], ["Sal", "2"]]) await quantity(page, name).fill(amount);
    // En el definitivo también se puede crear: entra con existencia 0 y hay que contarlo.
    await sheet(page).getByRole("button", { name: "Nuevo insumo", exact: true }).click();
    await fields.name.fill("Orégano");
    await fields.measure.selectOption({ label: "Unidades — un" });
    await dialog.getByRole("button", { name: "Crear", exact: true }).click();
    await expect(quantity(page, "Orégano")).toBeFocused();
    await page.keyboard.type("3");
    await page.keyboard.press("Enter");
    await expect(quantity(page, "Sal")).toHaveValue("2");
    await page.getByRole("button", { name: "Revisar ajuste definitivo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true })).toBeVisible();
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("03-revision-final.png") });
    await page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true }).click();
    await expect.poll(async () => (await db.stockCount.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("closed");
    // Tres insumos nacieron en el conteo: su existencia es lo contado y entran sin costo (no hay de dónde valorarlos).
    for (const [name, qty] of [["Pimienta negra", 6000], ["Laurel", 250], ["Orégano", 3000]] as const) {
      const item = await created(name);
      expect(item.stockLevel, name).toMatchObject({ qtyBase: qty, totalValueCents: 0 });
      const movements = await db.stockMovement.findMany({ where: { ingredientId: item.id } });
      expect(movements, name).toHaveLength(1);
      expect(movements[0], name).toMatchObject({ kind: "count_adjust", qtyBase: qty, valueCents: 0, stockCountId: session.id });
    }
    // Sin diferencia no hay ajuste; el restaurado conserva su existencia y su valor.
    expect(await db.stockMovement.count({ where: { stockCountId: session.id } })).toBe(3);
    expect((await created("Comino viejo")).stockLevel).toMatchObject({ qtyBase: 300, totalValueCents: 3000 });
    expect((await created("Sal")).stockLevel).toMatchObject({ qtyBase: 2000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await seed.cleanup(); }
});

test.afterAll(() => db.$disconnect());
