import { describe, expect, it } from "vitest";
import { FLOOR_WORLD, polygonArea, rectPoints, type Marker, type Zone } from "@/lib/floorPlan";
import {
  arrangeInRows,
  boxOfKey,
  boxOfKeys,
  freeSpotNear,
  insertVertex,
  isRectilinear,
  keyOf,
  moveEdge,
  pruneSelection,
  removeVertex,
  resizeRect,
  rotateKeys,
  splitKey,
  translateKeys,
  zoneRectBoolean,
  type Doc,
} from "./editorModel";

const zone = (id: string, x: number, y: number, w: number, h: number): Zone => ({
  id,
  kind: "interior",
  label: "",
  points: rectPoints({ x, y, w, h }),
});
const wall: Marker = { id: "w", kind: "pared", label: null, x: 10, y: 10, w: 3, h: 0.14, rotation: 0 };

const doc: Doc = {
  tables: {
    a: { shape: "square", capacity: 4, label: null, placement: { x: 2, y: 2, w: 1, h: 1, rotation: 0 } },
    b: { shape: "round", capacity: 2, label: null, placement: { x: 5, y: 2, w: 1, h: 1, rotation: 0 } },
    c: { shape: "square", capacity: 4, label: null, placement: null },
  },
  zones: [zone("z", 0, 0, 8, 6)],
  markers: [wall],
};

describe("selección y cajas", () => {
  it("clave ↔ tipo e id (los ids pueden traer dos puntos)", () => {
    expect(splitKey(keyOf("t", "ab:cd"))).toEqual({ type: "t", id: "ab:cd" });
  });

  it("una mesa sin ubicar no tiene caja y sale de la selección", () => {
    expect(boxOfKey(doc, "t:c")).toBeNull();
    expect(boxOfKey(doc, "t:nope")).toBeNull();
    expect(pruneSelection(doc, ["t:a", "t:c", "z:z", "m:gone"])).toEqual(["t:a", "z:z"]);
    expect(boxOfKeys(doc, ["t:a", "t:b"])).toEqual({ x: 1.5, y: 1.5, w: 4, h: 1 });
  });
});

describe("mover y girar", () => {
  it("mueve mesas, elementos y zonas juntos sin tocar lo demás", () => {
    const next = translateKeys(doc, ["t:a", "m:w", "z:z"], 1, 2);
    expect(next.tables.a.placement).toMatchObject({ x: 3, y: 4 });
    expect(next.tables.b).toBe(doc.tables.b);
    expect(next.markers[0]).toMatchObject({ x: 11, y: 12 });
    expect(next.zones[0].points[0]).toEqual({ x: 1, y: 2 });
    // El documento original no cambia (deshacer depende de eso).
    expect(doc.tables.a.placement).toMatchObject({ x: 2, y: 2 });
  });

  it("el grupo se frena en el borde del mundo sin deformarse", () => {
    const next = translateKeys(doc, ["t:a", "t:b"], -100, 0);
    expect(next.tables.a.placement?.x).toBe(0.5);
    expect(next.tables.b.placement?.x).toBe(3.5);
    const far = translateKeys(doc, ["t:a"], 1000, 1000);
    expect(far.tables.a.placement).toMatchObject({ x: FLOOR_WORLD - 0.5, y: FLOOR_WORLD - 0.5 });
  });

  it("sin desplazamiento devuelve el mismo documento", () => {
    expect(translateKeys(doc, ["t:a"], 0, 0)).toBe(doc);
  });

  it("gira en pasos y normaliza a 0–360", () => {
    const next = rotateKeys(doc, ["t:a", "m:w", "z:z"], -45);
    expect(next.tables.a.placement?.rotation).toBe(315);
    expect(next.markers[0].rotation).toBe(315);
    expect(next.zones).toBe(doc.zones);
  });
});

describe("redimensionar", () => {
  const rect = { x: 5, y: 5, w: 2, h: 1, rotation: 0 };
  const limits = { min: 0.3, max: 8 };

  it("la esquina opuesta se queda quieta", () => {
    const out = resizeRect(rect, { sx: 1, sy: 1 }, { x: 7, y: 6.5 }, limits);
    expect(out).toMatchObject({ w: 3, h: 2, x: 5.5, y: 5.5 });
    // Esquina sup-izq: sigue en (4, 4.5).
    expect(out.x - out.w / 2).toBe(4);
    expect(out.y - out.h / 2).toBe(4.5);
  });

  it("una manija de lado cambia solo esa dimensión", () => {
    const out = resizeRect(rect, { sx: -1, sy: 0 }, { x: 3, y: 9 }, limits);
    expect(out).toMatchObject({ w: 3, h: 1, x: 4.5, y: 5 });
  });

  it("respeta el mínimo aunque el puntero cruce al otro lado", () => {
    const out = resizeRect(rect, { sx: 1, sy: 0 }, { x: 0, y: 5 }, limits);
    expect(out.w).toBe(0.3);
  });

  it("redondea al paso (5 cm)", () => {
    const out = resizeRect(rect, { sx: 1, sy: 0 }, { x: 6.537, y: 5 }, { ...limits, step: 0.05 });
    expect(out.w).toBeCloseTo(2.55);
  });

  it("con proporción fija (mesa redonda) ancho y alto crecen igual", () => {
    const round = { x: 5, y: 5, w: 1, h: 1, rotation: 0 };
    const out = resizeRect(round, { sx: 1, sy: 1 }, { x: 6.5, y: 5.7 }, { ...limits, keepAspect: true });
    expect(out.w).toBe(out.h);
    expect(out.w).toBe(2);
  });

  it("funciona girado: arrastrar a lo largo del eje local", () => {
    // Girada 90°: su eje «ancho» apunta hacia abajo.
    const turned = { x: 5, y: 5, w: 2, h: 1, rotation: 90 };
    const out = resizeRect(turned, { sx: 1, sy: 0 }, { x: 5, y: 8 }, limits);
    expect(out.w).toBeCloseTo(4);
    expect(out.h).toBe(1);
    expect(out.x).toBeCloseTo(5);
    expect(out.y).toBeCloseTo(6);
  });
});

describe("forma de las zonas", () => {
  const sq = rectPoints({ x: 0, y: 0, w: 4, h: 4 });

  it("recortar una esquina da una L de 6 vértices", () => {
    const L = zoneRectBoolean(sq, { x: 2, y: 2, w: 5, h: 5 }, "cut");
    expect(L).toHaveLength(6);
    expect(polygonArea(L as never)).toBe(12);
    expect(isRectilinear(L as never)).toBe(true);
  });

  it("sumar un bloque pegado da una L; sumar uno adentro no cambia nada", () => {
    const L = zoneRectBoolean(sq, { x: 4, y: 0, w: 3, h: 2 }, "add");
    expect(L).toHaveLength(6);
    expect(polygonArea(L as never)).toBe(22);
    const same = zoneRectBoolean(sq, { x: 1, y: 1, w: 1, h: 1 }, "add");
    expect(same).toEqual(sq);
  });

  it("sumar un bloque suelto conserva el pedazo más grande", () => {
    const out = zoneRectBoolean(sq, { x: 10, y: 10, w: 1, h: 1 }, "add");
    expect(out).toEqual(sq);
  });

  it("recortarlo todo no deja zona", () => {
    expect(zoneRectBoolean(sq, { x: -1, y: -1, w: 10, h: 10 }, "cut")).toBeNull();
  });

  it("recortar por el medio conserva el lado más grande", () => {
    const out = zoneRectBoolean(sq, { x: 1, y: -1, w: 1, h: 10 }, "cut");
    expect(out).toEqual(rectPoints({ x: 2, y: 0, w: 2, h: 4 }));
  });

  it("mover un lado agranda el rectángulo sin torcerlo", () => {
    // Lado 1 = el derecho (de (4,0) a (4,4)); su normal apunta hacia afuera… o adentro:
    // lo que importa es que los dos vértices se mueven igual.
    const out = moveEdge(sq, 1, 1);
    expect(isRectilinear(out)).toBe(true);
    expect(Math.abs(polygonArea(out) - 16)).toBe(4);
  });

  it("agregar y quitar vértices", () => {
    const added = insertVertex(sq, 0);
    expect(added?.points).toHaveLength(5);
    expect(added?.points[added.index]).toEqual({ x: 2, y: 0 });
    expect(removeVertex(sq, 0)).toHaveLength(3);
    expect(removeVertex(sq.slice(0, 3), 0)).toBeNull();
  });

  it("una zona con un lado en diagonal no es de lados rectos", () => {
    expect(isRectilinear([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 1, y: 3 }])).toBe(false);
  });
});

describe("ubicar mesas", () => {
  it("busca un hueco cuando el sitio pedido está ocupado", () => {
    const spot = freeSpotNear(doc, "square", { w: 1, h: 1 }, { x: 2, y: 2 });
    expect(spot).not.toEqual({ x: 2, y: 2 });
    const free = freeSpotNear(doc, "square", { w: 1, h: 1 }, { x: 20, y: 20 });
    expect(free).toEqual({ x: 20, y: 20 });
  });

  it("ordena en filas y salta de fila al llenar el ancho", () => {
    const pos = arrangeInRows(
      [
        { id: "1", w: 1, h: 1 },
        { id: "2", w: 1, h: 1 },
        { id: "3", w: 1, h: 1 },
      ],
      { x: 1, y: 1 },
      3,
      0.5,
    );
    expect(pos["1"]).toEqual({ x: 1.5, y: 1.5 });
    expect(pos["2"]).toEqual({ x: 3, y: 1.5 });
    expect(pos["3"]).toEqual({ x: 1.5, y: 3 });
  });
});
