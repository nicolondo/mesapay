import { describe, expect, it } from "vitest";
import { computeNitDv } from "@/lib/erp/exogena";
import {
  comboboxKeyAction,
  exactSupplierByName,
  foldSearchText,
  rankSuppliers,
  supplierMatchTier,
  taxIdKeys,
  type ComboboxKeyInput,
} from "./supplierSearch";

const DV = computeNitDv("900123456")!;

const SUPPLIERS = [
  { id: "carnes", name: "Carnes del Valle S.A.S.", taxId: `900.123.456-${DV}` },
  { id: "pollo", name: "Avícola Don Pollo", taxId: "800222333", aliases: ["Pollos Ñaños Ltda"] },
  { id: "verduras", name: "Verduras La Plaza", taxId: null },
  { id: "panaderia", name: "Panadería El Trigal", taxId: "1020304050" },
  { id: "lacteos", name: "Lácteos Andinos", taxId: "811999888-1" },
  { id: "dist", name: "Distribuidora Carnes Premium", taxId: null },
];
const ids = (q: string, recentIds?: string[]) =>
  rankSuppliers(SUPPLIERS, q, { recentIds }).map((s) => s.id);

describe("foldSearchText", () => {
  it("ignora acentos, mayúsculas y puntuación", () => {
    expect(foldSearchText("  PANADERÍA  El-Trigal, S.A.S. ")).toBe("panaderia el trigal s a s");
    expect(foldSearchText("Ñaños")).toBe("nanos");
  });
});

describe("taxIdKeys", () => {
  it("acepta el NIT guardado con DV y puntuación, con o sin el DV", () => {
    const keys = taxIdKeys(`900.123.456-${DV}`);
    expect(keys).toContain("900123456");
    expect(keys).toContain(`900123456${DV}`);
  });
  it("calcula el DV cuando se guardó sin él", () => {
    expect(taxIdKeys("900123456")).toContain(`900123456${DV}`);
  });
  it("sin NIT no hay claves", () => {
    expect(taxIdKeys(null)).toEqual([]);
    expect(taxIdKeys("  ")).toEqual([]);
  });
});

describe("búsqueda por NIT", () => {
  it.each([
    ["900123456"],
    [`900123456-${DV}`],
    [`900.123.456-${DV}`],
    [`900123456${DV}`],
    ["900 123 456"],
  ])("«%s» encuentra al proveedor guardado con puntos y DV", (q) => {
    expect(supplierMatchTier(SUPPLIERS[0]!, q)).toBe(0);
    expect(ids(q)[0]).toBe("carnes");
  });
  it("con el NIT guardado sin DV, también lo encuentra escrito con DV", () => {
    const dv = computeNitDv("800222333");
    expect(ids(`800.222.333-${dv}`)).toEqual(["pollo"]);
  });
  it("un prefijo del NIT basta", () => {
    expect(ids("900.12")).toEqual(["carnes"]);
    expect(supplierMatchTier(SUPPLIERS[0]!, "900.12")).toBe(1);
  });
  it("el DV mal escrito no impide encontrar por la base", () => {
    const wrong = (Number(DV) + 1) % 10;
    expect(ids(`900123456-${wrong}`)[0]).toBe("carnes");
  });
  it("un dígito suelto no dispara búsqueda por NIT", () => {
    expect(ids("8")).toEqual([]);
  });
});

describe("búsqueda por nombre", () => {
  it("ignora acentos y mayúsculas", () => {
    expect(ids("avicola")).toEqual(["pollo"]);
    expect(ids("LACTEOS")).toEqual(["lacteos"]);
    expect(ids("panaderia el trigal")).toEqual(["panaderia"]);
  });
  it("ordena: prefijo > inicio de palabra > contiene", () => {
    // "Carnes del Valle" empieza con «carn»; "Distribuidora Carnes" la tiene
    // al inicio de una palabra.
    expect(ids("carn")).toEqual(["carnes", "dist"]);
    expect(supplierMatchTier(SUPPLIERS[0]!, "carn")).toBe(1);
    expect(supplierMatchTier(SUPPLIERS[5]!, "carn")).toBe(2);
    // «ARN» sólo está dentro de las palabras.
    expect(supplierMatchTier(SUPPLIERS[0]!, "arn")).toBe(3);
  });
  it("varias palabras en cualquier orden", () => {
    expect(ids("plaza verd")).toEqual(["verduras"]);
  });
  it("encuentra aunque se escriba todo junto", () => {
    expect(ids("donpollo")).toEqual(["pollo"]);
  });
  it("busca también por alias, por debajo del nombre a igual nivel", () => {
    expect(ids("nanos")).toEqual(["pollo"]);
    expect(supplierMatchTier(SUPPLIERS[1]!, "pollos")).toBe(1.5);
    expect(supplierMatchTier(SUPPLIERS[1]!, "avicola")).toBe(1);
  });
  it("a igual nivel ganan los recientes y luego el alfabético", () => {
    // «a»: Avícola (prefijo) > Carnes «S.A.S.» y Lácteos «Andinos» (palabra)
    // > el resto (contiene), alfabético dentro de cada nivel.
    expect(ids("a")).toEqual(["pollo", "carnes", "lacteos", "dist", "panaderia", "verduras"]);
    expect(ids("a", ["lacteos"])).toEqual(["pollo", "lacteos", "carnes", "dist", "panaderia", "verduras"]);
    expect(ids("carn", ["dist"])).toEqual(["carnes", "dist"]); // el nivel pesa más que lo reciente
    expect(ids("la", ["verduras"])[0]).toBe("lacteos"); // prefijo > palabra reciente
  });
});

describe("sin búsqueda", () => {
  it("recientes primero (en orden de uso) y luego alfabético", () => {
    expect(ids("", ["verduras", "pollo"])).toEqual([
      "verduras",
      "pollo",
      "carnes",
      "dist",
      "lacteos",
      "panaderia",
    ]);
  });
  it("ignora recientes que ya no están en la lista y respeta el límite", () => {
    expect(rankSuppliers(SUPPLIERS, "", { recentIds: ["borrado"], limit: 2 }).map((s) => s.id)).toEqual([
      "pollo",
      "carnes",
    ]);
  });
});

describe("exactSupplierByName", () => {
  it("resuelve el nombre exacto sin acentos ni mayúsculas", () => {
    expect(exactSupplierByName(SUPPLIERS, "lacteos andinos")?.id).toBe("lacteos");
    expect(exactSupplierByName(SUPPLIERS, "lacteos")).toBeNull();
    expect(exactSupplierByName(SUPPLIERS, "")).toBeNull();
  });
});

describe("comboboxKeyAction (teclado)", () => {
  // 3 proveedores + «Crear» en el índice 3.
  const base: ComboboxKeyInput = {
    key: "",
    open: true,
    active: 0,
    optionCount: 4,
    createIndex: 3,
    typed: true,
  };
  const run = (over: Partial<ComboboxKeyInput>) => comboboxKeyAction({ ...base, ...over });

  it("↓/↑ abren la lista cerrada", () => {
    expect(run({ key: "ArrowDown", open: false, active: -1 }).action).toEqual({ kind: "open", active: 0 });
    expect(run({ key: "ArrowUp", open: false, active: -1 }).action).toEqual({ kind: "open", active: 3 });
  });
  it("↓/↑ recorren las opciones en círculo, incluida «Crear»", () => {
    expect(run({ key: "ArrowDown", active: 2 }).action).toEqual({ kind: "move", active: 3 });
    expect(run({ key: "ArrowDown", active: 3 }).action).toEqual({ kind: "move", active: 0 });
    expect(run({ key: "ArrowUp", active: 0 }).action).toEqual({ kind: "move", active: 3 });
    expect(run({ key: "ArrowUp", active: -1 }).action).toEqual({ kind: "move", active: 3 });
  });
  it("Enter elige la opción resaltada (proveedor o «Crear») sin enviar el formulario", () => {
    expect(run({ key: "Enter", active: 1 })).toEqual({ action: { kind: "pick", index: 1 }, preventDefault: true });
    expect(run({ key: "Enter", active: 3 })).toEqual({ action: { kind: "pick", index: 3 }, preventDefault: true });
    expect(run({ key: "Enter", active: -1 })).toEqual({ action: { kind: "close" }, preventDefault: true });
  });
  it("Enter con la lista cerrada deja enviar el formulario", () => {
    expect(run({ key: "Enter", open: false })).toEqual({ action: { kind: "none" }, preventDefault: false });
  });
  it("Esc cierra; con la lista cerrada borra lo escrito", () => {
    expect(run({ key: "Escape" }).action).toEqual({ kind: "close" });
    expect(run({ key: "Escape", open: false }).action).toEqual({ kind: "clearText" });
    expect(run({ key: "Escape", open: false, typed: false })).toEqual({ action: { kind: "none" }, preventDefault: false });
  });
  it("Tab acepta el proveedor resaltado y deja avanzar el foco", () => {
    expect(run({ key: "Tab", active: 1 })).toEqual({ action: { kind: "pick", index: 1 }, preventDefault: false });
  });
  it("Tab nunca dispara «Crear» ni elige sin haber escrito", () => {
    expect(run({ key: "Tab", active: 3 }).action).toEqual({ kind: "close" });
    expect(run({ key: "Tab", active: 1, typed: false }).action).toEqual({ kind: "close" });
  });
  it("sin opciones, las flechas no hacen nada", () => {
    expect(run({ key: "ArrowDown", optionCount: 0, active: -1, createIndex: -1 }).action).toEqual({ kind: "none" });
  });
});
