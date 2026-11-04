import { describe, expect, it } from "vitest";
import { accountLabel, accountMatchTier, exactAccount, rankAccounts } from "./accountSearch";
import { comboboxKeyAction } from "@/lib/suppliers/supplierSearch";

const CHART = [
  { code: "513505", name: "Aseo y vigilancia" },
  { code: "513525", name: "Acueducto y alcantarillado" },
  { code: "513530", name: "Energía eléctrica" },
  { code: "513535", name: "Teléfono e internet" },
  { code: "512010", name: "Arrendamientos — construcciones y edificaciones" },
  { code: "511005", name: "Honorarios — junta directiva" },
  { code: "519505", name: "Gastos diversos — comisiones" },
  { code: "613505", name: "Costo de ventas — alimentos" },
];

describe("rankAccounts", () => {
  it("los números son prefijo del código (y el código exacto va primero)", () => {
    expect(rankAccounts(CHART, "5135").map((a) => a.code)).toEqual(["513505", "513525", "513530", "513535"]);
    expect(rankAccounts(CHART, "513525").map((a) => a.code)).toEqual(["513525"]);
    expect(rankAccounts(CHART, "35").map((a) => a.code)).toEqual([]);
  });

  it("las palabras van contra el nombre, sin acentos ni mayúsculas", () => {
    expect(rankAccounts(CHART, "energia").map((a) => a.code)).toEqual(["513530"]);
    expect(rankAccounts(CHART, "TELEFONO").map((a) => a.code)).toEqual(["513535"]);
    // Inicio de palabra antes que «contiene».
    expect(rankAccounts(CHART, "comis").map((a) => a.code)).toEqual(["519505"]);
    expect(rankAccounts(CHART, "internet tel").map((a) => a.code)).toEqual(["513535"]);
  });

  it("código y palabras a la vez: tienen que calzar las dos", () => {
    expect(rankAccounts(CHART, "5135 agua").map((a) => a.code)).toEqual([]);
    expect(rankAccounts(CHART, "5135 acue").map((a) => a.code)).toEqual(["513525"]);
  });

  it("sin búsqueda: todas, por código; con límite", () => {
    expect(rankAccounts(CHART, "").map((a) => a.code)).toEqual([...CHART].map((a) => a.code).sort());
    expect(rankAccounts(CHART, "", { limit: 2 })).toHaveLength(2);
  });

  it("niveles: exacto < prefijo < inicio de palabra < contiene", () => {
    const a = { code: "513530", name: "Energía eléctrica" };
    expect(accountMatchTier(a, "513530")).toBeLessThan(accountMatchTier(a, "5135")!);
    expect(accountMatchTier(a, "energia")).toBeLessThan(accountMatchTier(a, "electrica")!);
    expect(accountMatchTier(a, "lectri")).toBeGreaterThan(accountMatchTier(a, "electrica")!);
    expect(accountMatchTier(a, "agua")).toBeNull();
  });
});

describe("exactAccount / accountLabel", () => {
  it("resuelve lo escrito sin elegir: el código exacto o «código · nombre» completo", () => {
    expect(exactAccount(CHART, " 513530 ")?.name).toBe("Energía eléctrica");
    expect(exactAccount(CHART, accountLabel(CHART[1]!))?.code).toBe("513525");
    expect(exactAccount(CHART, "5135")).toBeNull();
    expect(exactAccount(CHART, "")).toBeNull();
  });
});

describe("teclado (el mismo patrón del combobox de proveedores)", () => {
  it("↓ abre en la primera opción («Automática»), Enter la elige, Esc cierra", () => {
    const base = { open: false, active: -1, optionCount: 5, createIndex: -1, typed: false };
    expect(comboboxKeyAction({ ...base, key: "ArrowDown" }).action).toEqual({ kind: "open", active: 0 });
    expect(comboboxKeyAction({ ...base, open: true, active: 0, key: "Enter" }).action).toEqual({ kind: "pick", index: 0 });
    expect(comboboxKeyAction({ ...base, open: true, key: "Escape" }).action).toEqual({ kind: "close" });
  });
});
