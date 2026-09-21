import { describe, expect, it } from "vitest";
import {
  buildPucTree,
  expandableKeys,
  flattenTree,
  isRowVisible,
  parseExpansion,
  pucParentCodes,
  serializeExpansion,
  treeTotals,
  type PucLeaf,
  type PucNode,
} from "./pucTree";

const leaves: PucLeaf[] = [
  { code: "110505", name: "Caja general", values: [100, 10, 5, 105] },
  { code: "111005", name: "Bancos", values: [200, 0, 50, 150] },
  { code: "24080501", name: "IVA 5%", values: [-30, 0, 3, -33] },
  { code: "24080519", name: "IVA 19%", values: [-70, 0, 19, -89] },
  { code: "413505", name: "Ventas", values: [0, 0, 500, -500] },
  { code: "2205", name: "Proveedores (hoja de 4 dígitos)", values: [-40, 20, 0, -20] },
];

/** Suma de las hojas de la entrada cuyo código empieza por el prefijo. */
function leafSum(prefix: string): number[] {
  const out = [0, 0, 0, 0];
  for (const l of leaves) {
    if (!l.code.startsWith(prefix)) continue;
    l.values.forEach((v, i) => (out[i] += v));
  }
  return out;
}

function walk(nodes: PucNode[], fn: (n: PucNode) => void) {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
}

describe("buildPucTree — invariantes", () => {
  it("cada nodo = suma exacta de sus hojas, en todas las columnas", () => {
    const tree = buildPucTree(leaves);
    let visited = 0;
    walk(tree, (n) => {
      visited++;
      expect(n.values).toEqual(leafSum(n.code));
    });
    expect(visited).toBeGreaterThan(0);
    expect(treeTotals(tree, 4)).toEqual(leafSum(""));
  });

  it("jerarquía clase → grupo → cuenta → subcuenta, con depth y orden por código", () => {
    const rows = flattenTree(buildPucTree(leaves));
    expect(rows.map((r) => `${r.depth}:${r.code}`)).toEqual([
      "0:1",
      "1:11",
      "2:1105",
      "3:110505",
      "2:1110",
      "3:111005",
      "0:2",
      "1:22",
      "2:2205",
      "1:24",
      "2:2408",
      "3:240805",
      "0:4",
      "1:41",
      "2:4135",
      "3:413505",
    ]);
  });

  it("los auxiliares de 8 dígitos se agregan en su subcuenta de 6", () => {
    const rows = flattenTree(buildPucTree(leaves));
    const iva = rows.find((r) => r.code === "240805")!;
    expect(iva.values).toEqual([-100, 0, 22, -122]);
    expect(iva.hasChildren).toBe(false);
  });

  it("una hoja cuyo código ES un nivel toma su nombre y es ese nodo", () => {
    const rows = flattenTree(buildPucTree(leaves));
    const prov = rows.find((r) => r.code === "2205")!;
    expect(prov.name).toBe("Proveedores (hoja de 4 dígitos)");
    expect(prov.depth).toBe(2);
    expect(prov.values).toEqual([-40, 20, 0, -20]);
  });

  it("nivel máximo: con [1, 2] todo se agrega en el grupo", () => {
    const rows = flattenTree(buildPucTree(leaves, { levels: [1, 2] }));
    expect(rows.map((r) => r.code)).toEqual(["1", "11", "2", "22", "24", "4", "41"]);
    expect(rows.find((r) => r.code === "11")!.values).toEqual(leafSum("11"));
  });
});

describe("buildPucTree — nombres", () => {
  it("usa el plan de cuentas y cae al nombre de clase del Decreto 2650", () => {
    const rows = flattenTree(
      buildPucTree(leaves, { names: { "11": "Disponible", "1105": "Caja", "2408": "IVA" } }),
    );
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r.name]));
    expect(byCode["1"]).toBe("Activo");
    expect(byCode["2"]).toBe("Pasivo");
    expect(byCode["4"]).toBe("Ingresos");
    expect(byCode["11"]).toBe("Disponible");
    expect(byCode["1105"]).toBe("Caja");
    expect(byCode["2408"]).toBe("IVA");
    // Prefijo sin nombre en el plan: vacío (la vista muestra el código).
    expect(byCode["41"]).toBe("");
    // La hoja conserva su nombre propio.
    expect(byCode["110505"]).toBe("Caja general");
  });

  it("pucParentCodes lista los prefijos presentes", () => {
    expect(pucParentCodes(["110505", "413505"], [1, 2, 4])).toEqual([
      "1",
      "11",
      "1105",
      "4",
      "41",
      "4135",
    ]);
  });
});

describe("expansión (?abrir=)", () => {
  it("parse: vacío = default, * = todo, lista = ramas", () => {
    expect(parseExpansion(undefined)).toEqual(new Set());
    expect(parseExpansion("")).toEqual(new Set());
    expect(parseExpansion("*")).toBe("all");
    expect(parseExpansion("1,11,,2")).toEqual(new Set(["1", "11", "2"]));
  });

  it("serialize: null = default, * = todo, lista ordenada", () => {
    expect(serializeExpansion(new Set())).toBeNull();
    expect(serializeExpansion("all")).toBe("*");
    expect(serializeExpansion(new Set(["2", "1", "11"]))).toBe("1,11,2");
    expect(parseExpansion(serializeExpansion(new Set(["4", "41"])))).toEqual(new Set(["4", "41"]));
  });

  it("visibilidad: solo con TODOS los ancestros abiertos", () => {
    const rows = flattenTree(buildPucTree(leaves));
    const caja = rows.find((r) => r.code === "110505")!;
    expect(isRowVisible(caja, new Set())).toBe(false);
    expect(isRowVisible(caja, new Set(["1", "11"]))).toBe(false);
    expect(isRowVisible(caja, new Set(["1", "11", "1105"]))).toBe(true);
    expect(isRowVisible(caja, "all")).toBe(true);
    expect(isRowVisible(rows[0], new Set())).toBe(true);
    expect(expandableKeys(rows)).toContain("1105");
    expect(expandableKeys(rows)).not.toContain("110505");
  });
});
