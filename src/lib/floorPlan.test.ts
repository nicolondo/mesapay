import { describe, expect, it } from "vitest";
import {
  FLOOR_MAX_ZONE_POINTS,
  FLOOR_WORLD,
  LEGACY_OFFSET,
  LEGACY_TABLE_SIZE,
  TABLE_SIZE_MAX,
  TABLE_SIZE_MIN,
  buildStoredFloorPlan,
  cellsToPolygons,
  cleanPolygon,
  convexOverlapDepth,
  defaultTableSize,
  findOverlaps,
  isAxisRect,
  isV2Stored,
  legacyToScene,
  normalizeRotation,
  pointInPolygon,
  polygonArea,
  projectToLegacy,
  rectBounds,
  rectCorners,
  rectPoints,
  resolveFloor,
  resolveLegacyFloorPlan,
  sanitizePlacement,
  sanitizeScene,
  sceneBounds,
  seatLayout,
  tableOutline,
  zoneAtPoint,
  zoneLabelAnchor,
  zoneOfPlacement,
  type FloorTableRow,
  type TablePlacement,
  type Zone,
} from "./floorPlan";

const row = (over: Partial<FloorTableRow> & { id: string }): FloorTableRow => ({
  shape: "square",
  floorPlanX: null,
  floorPlanY: null,
  floorX: null,
  floorY: null,
  floorW: null,
  floorH: null,
  floorRotation: null,
  ...over,
});

const place = (over: Partial<TablePlacement>): TablePlacement => ({
  x: 5,
  y: 5,
  w: 1,
  h: 1,
  rotation: 0,
  ...over,
});

/** Celdas de un rectángulo, como las guardaba el editor viejo. */
function block(x: number, y: number, w: number, h: number) {
  const out: { x: number; y: number }[] = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push({ x: x + dx, y: y + dy });
  return out;
}

describe("plano viejo (celdas) → plano libre", () => {
  it("un bloque rectangular de celdas es un rectángulo de 4 puntos", () => {
    const polys = cellsToPolygons(block(2, 1, 3, 2));
    expect(polys).toHaveLength(1);
    expect(polys[0]).toEqual([
      { x: 2, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 3 },
      { x: 2, y: 3 },
    ]);
    expect(isAxisRect(polys[0])).toBe(true);
  });

  it("una zona en L conserva su forma: 6 vértices y la misma área", () => {
    // ██
    // █
    const cells = [...block(0, 0, 2, 1), { x: 0, y: 1 }];
    const [poly] = cellsToPolygons(cells);
    expect(poly).toHaveLength(6);
    expect(polygonArea(poly)).toBe(3);
    expect(isAxisRect(poly)).toBe(false);
    // El hueco de la L queda afuera.
    expect(pointInPolygon({ x: 1.5, y: 1.5 }, poly)).toBe(false);
    expect(pointInPolygon({ x: 0.5, y: 1.5 }, poly)).toBe(true);
  });

  it("celdas sueltas (no pegadas por un lado) dan una zona por grupo", () => {
    const polys = cellsToPolygons([...block(0, 0, 2, 2), ...block(5, 5, 1, 1)]);
    expect(polys).toHaveLength(2);
    expect(polys.map(polygonArea).sort()).toEqual([1, 4]);
  });

  it("un hueco interior se rellena: queda el borde exterior", () => {
    const ring = block(0, 0, 3, 3).filter((c) => !(c.x === 1 && c.y === 1));
    const [poly] = cellsToPolygons(ring);
    expect(poly).toHaveLength(4);
    expect(polygonArea(poly)).toBe(9);
  });

  it("dos celdas que solo se tocan en diagonal dentro de un mismo grupo no cruzan el contorno", () => {
    // ·██     (0,0) falta; el grupo rodea el hueco (1,1) y se toca en
    // █·█     diagonal en el vértice (1,1)/(2,2)
    // ███
    const cells = [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ];
    const polys = cellsToPolygons(cells);
    expect(polys).toHaveLength(1);
    // Contorno exterior: todo el cuadro 3×3 menos la esquina (0,0).
    expect(polygonArea(polys[0])).toBe(8);
  });

  it("convierte el blob viejo completo: zonas, íconos y mesas al centro de su celda", () => {
    const stored = {
      cols: 10,
      rows: 6,
      zones: [
        { id: "za", kind: "terraza", label: "Terraza", cells: block(0, 0, 4, 2) },
        { id: "zb", kind: "custom", label: "VIP", cells: block(6, 0, 2, 2) },
      ],
      markers: [{ id: "m1", kind: "entrada", label: null, x: 9, y: 5 }],
    };
    const rows = [
      row({ id: "t1", floorPlanX: 1, floorPlanY: 0 }),
      row({ id: "t2", floorPlanX: 7, floorPlanY: 1, shape: "bar" }),
      row({ id: "t3" }),
    ];
    const { scene, placements, source } = resolveFloor(stored, rows);
    expect(source).toBe("legacy");
    expect(scene.zones.map((z) => z.id)).toEqual(["za", "zb"]);
    // El rótulo por defecto del tipo no se copia: se traduce al mostrar.
    expect(scene.zones[0].label).toBe("");
    expect(scene.zones[1].label).toBe("VIP");
    // Corrido LEGACY_OFFSET para dejar margen arriba y a la izquierda.
    const o = LEGACY_OFFSET;
    expect(scene.zones[0].points).toEqual(rectPoints({ x: o, y: o, w: 4, h: 2 }));
    expect(scene.markers[0]).toMatchObject({ kind: "entrada", x: 9.5 + o, y: 5.5 + o, rotation: 0 });
    expect(placements.t1).toEqual({
      x: 1.5 + o,
      y: 0.5 + o,
      w: LEGACY_TABLE_SIZE,
      h: LEGACY_TABLE_SIZE,
      rotation: 0,
    });
    expect(placements.t2.w).toBeGreaterThan(placements.t2.h);
    expect(placements.t3).toBeUndefined();
    // La mesa sigue dentro de su zona tras convertir.
    expect(zoneOfPlacement(scene.zones, placements.t1)?.id).toBe("za");
    expect(zoneOfPlacement(scene.zones, placements.t2)?.id).toBe("zb");
  });

  it("mesas vecinas del plano viejo no quedan solapadas al convertir", () => {
    const rows = [
      row({ id: "a", floorPlanX: 0, floorPlanY: 0 }),
      row({ id: "b", floorPlanX: 1, floorPlanY: 0 }),
      row({ id: "c", floorPlanX: 0, floorPlanY: 1, shape: "round" }),
    ];
    const { placements } = resolveFloor(null, rows);
    const overlaps = findOverlaps(
      rows.map((r) => ({ id: r.id, shape: r.shape, placement: placements[r.id] })),
    );
    expect(overlaps.size).toBe(0);
  });

  it("un restaurante sin plano guardado da una escena vacía, sin tirar", () => {
    for (const stored of [null, undefined, 7, "x", [], {}]) {
      const { scene, placements, source } = resolveFloor(stored, []);
      expect(scene).toEqual({ zones: [], markers: [] });
      expect(placements).toEqual({});
      expect(source).toBe("legacy");
    }
  });

  it("el formato más viejo (zona rectángulo x,y,w,h) también se lee", () => {
    const legacy = resolveLegacyFloorPlan({
      cols: 8,
      rows: 8,
      zones: [{ id: "z", kind: "jardin", x: 1, y: 1, w: 3, h: 2 }],
    });
    expect(legacy.zones[0].cells).toHaveLength(6);
    expect(legacyToScene(legacy).zones[0].points).toEqual(
      rectPoints({ x: 1 + LEGACY_OFFSET, y: 1 + LEGACY_OFFSET, w: 3, h: 2 }),
    );
  });
});

describe("formato libre (v2)", () => {
  const scene = {
    zones: [
      {
        id: "sala",
        kind: "interior",
        label: "",
        points: [
          { x: 0, y: 0 },
          { x: 8, y: 0 },
          { x: 8, y: 3 },
          { x: 4, y: 3 },
          { x: 4, y: 6 },
          { x: 0, y: 6 },
        ],
      },
    ],
    markers: [{ id: "p", kind: "pared", label: null, x: 4, y: 3, w: 3, h: 0.14, rotation: 45 }],
  };

  it("con version 2 mandan la escena v2 y las columnas libres de cada mesa", () => {
    const stored = buildStoredFloorPlan(sanitizeScene(scene), {
      cols: 10,
      rows: 6,
      zones: [],
      markers: [],
    });
    expect(isV2Stored(stored)).toBe(true);
    const rows = [
      // Las celdas viejas se IGNORAN cuando el blob es v2.
      row({ id: "t1", floorPlanX: 9, floorPlanY: 9, floorX: 2.25, floorY: 1.5, floorW: 1.2, floorH: 0.8, floorRotation: 30 }),
      row({ id: "t2", floorPlanX: 3, floorPlanY: 3 }),
    ];
    const out = resolveFloor(stored, rows);
    expect(out.source).toBe("v2");
    expect(out.scene.zones[0].points).toHaveLength(6);
    expect(out.scene.markers[0]).toMatchObject({ kind: "pared", rotation: 45 });
    expect(out.placements.t1).toEqual({ x: 2.25, y: 1.5, w: 1.2, h: 0.8, rotation: 30 });
    expect(out.placements.t2).toBeUndefined();
  });

  it("si el código viejo guarda encima (blob sin version), vuelve a mandar lo viejo", () => {
    const saved = buildStoredFloorPlan(sanitizeScene(scene), {
      cols: 10,
      rows: 6,
      zones: [{ id: "sala", kind: "interior", label: "", cells: block(0, 0, 2, 2) }],
      markers: [],
    });
    // El editor viejo reescribe solo las 4 claves que conoce.
    const { cols, rows: gridRows, zones, markers } = resolveLegacyFloorPlan(saved);
    const rewritten = { cols, rows: gridRows, zones, markers };
    expect(isV2Stored(rewritten)).toBe(false);
    const out = resolveFloor(rewritten, [
      row({ id: "t1", floorPlanX: 1, floorPlanY: 1, floorX: 40, floorY: 40, floorW: 1, floorH: 1 }),
    ]);
    expect(out.source).toBe("legacy");
    expect(out.placements.t1).toMatchObject({ x: 1.5 + LEGACY_OFFSET, y: 1.5 + LEGACY_OFFSET });
  });

  it("parseo defensivo: basura adentro, escena válida afuera", () => {
    const dirty = {
      zones: [
        null,
        "zona",
        { id: "ok", kind: "terraza", label: "  Terraza norte  ", points: rectPoints({ x: 1, y: 1, w: 2, h: 2 }) },
        { id: "tipo", kind: "piscina", points: rectPoints({ x: 1, y: 1, w: 2, h: 2 }) },
        { id: "dos", kind: "interior", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { id: "nan", kind: "interior", points: [{ x: NaN, y: 0 }, { x: Infinity, y: 1 }, { x: "3", y: 2 }] },
        { id: "linea", kind: "interior", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] },
        { id: "fuera", kind: "jardin", points: rectPoints({ x: -50, y: -50, w: 500, h: 500 }) },
        { id: "ok", kind: "barra", points: rectPoints({ x: 3, y: 3, w: 1, h: 1 }) },
      ],
      markers: [
        { id: "m", kind: "entrada", x: 2, y: 2 },
        { id: "x", kind: "ovni", x: 2, y: 2 },
        { id: "n", kind: "banos", x: NaN, y: 2 },
        { id: "g", kind: "pared", x: 5, y: 5, w: 9999, h: -3, rotation: 725 },
        7,
      ],
      extra: { __proto__: { polluted: true } },
    };
    const clean = sanitizeScene(dirty);
    expect(clean.zones.map((z) => z.kind)).toEqual(["terraza", "jardin", "barra"]);
    expect(clean.zones[0].label).toBe("Terraza norte");
    // Acotado al mundo.
    expect(clean.zones[1].points).toEqual(rectPoints({ x: 0, y: 0, w: FLOOR_WORLD, h: FLOOR_WORLD }));
    // Ids repetidos se desambiguan.
    expect(new Set(clean.zones.map((z) => z.id)).size).toBe(3);
    expect(clean.markers.map((m) => m.kind)).toEqual(["entrada", "pared"]);
    expect(clean.markers[0]).toMatchObject({ w: 1, h: 0.8, rotation: 0, label: null });
    expect(clean.markers[1]).toMatchObject({ w: 30, h: 0.1, rotation: 5 });
    expect(sanitizeScene(null)).toEqual({ zones: [], markers: [] });
    expect(sanitizeScene("x")).toEqual({ zones: [], markers: [] });
  });

  it("un polígono con demasiados vértices se descarta entero", () => {
    const many = Array.from({ length: FLOOR_MAX_ZONE_POINTS + 5 }, (_, i) => ({
      x: 10 + Math.cos(i) * 5,
      y: 10 + Math.sin(i) * 5,
    }));
    expect(cleanPolygon(many)).toBeNull();
  });

  it("colocación de mesa: acota tamaño y posición, y rechaza lo no finito", () => {
    expect(sanitizePlacement({ x: 1, y: 2, w: 100, h: 0.01, rotation: -90 })).toEqual({
      x: 1,
      y: 2,
      w: TABLE_SIZE_MAX,
      h: TABLE_SIZE_MIN,
      rotation: 270,
    });
    expect(sanitizePlacement({ x: -5, y: 999, w: 1, h: 1 })).toMatchObject({
      x: 0,
      y: FLOOR_WORLD,
      rotation: 0,
    });
    expect(sanitizePlacement({ x: NaN, y: 0, w: 1, h: 1 })).toBeNull();
    expect(sanitizePlacement({ x: 1, y: 1, w: null, h: 1 })).toBeNull();
    expect(sanitizePlacement(null)).toBeNull();
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-15)).toBe(345);
    expect(normalizeRotation(359.97)).toBe(0);
  });
});

describe("geometría", () => {
  const sala: Zone = {
    id: "sala",
    kind: "interior",
    label: "",
    points: rectPoints({ x: 0, y: 0, w: 10, h: 6 }),
  };
  const barra: Zone = {
    id: "barra",
    kind: "barra",
    label: "",
    points: rectPoints({ x: 6, y: 0, w: 4, h: 2 }),
  };

  it("punto en polígono irregular (L)", () => {
    const L = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 5 },
      { x: 0, y: 5 },
    ];
    expect(pointInPolygon({ x: 1, y: 4 }, L)).toBe(true);
    expect(pointInPolygon({ x: 3, y: 1 }, L)).toBe(true);
    expect(pointInPolygon({ x: 3, y: 4 }, L)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 1 }, L)).toBe(false);
  });

  it("la zona de una mesa es la más específica que contiene su centro", () => {
    expect(zoneOfPlacement([sala, barra], place({ x: 7, y: 1 }))?.id).toBe("barra");
    expect(zoneOfPlacement([barra, sala], place({ x: 7, y: 1 }))?.id).toBe("barra");
    expect(zoneOfPlacement([sala, barra], place({ x: 2, y: 4 }))?.id).toBe("sala");
    expect(zoneOfPlacement([sala, barra], place({ x: 20, y: 20 }))).toBeNull();
    expect(zoneAtPoint([], { x: 1, y: 1 })).toBeNull();
  });

  it("un rectángulo girado 90° intercambia ancho y alto de su caja", () => {
    const b = rectBounds(place({ x: 5, y: 5, w: 2, h: 1, rotation: 90 }));
    expect(b.w).toBeCloseTo(1);
    expect(b.h).toBeCloseTo(2);
    const corners = rectCorners(place({ x: 0, y: 0, w: 2, h: 2, rotation: 45 }));
    expect(corners[0].x).toBeCloseTo(0);
    expect(corners[0].y).toBeCloseTo(-Math.SQRT2);
  });

  it("avisa de mesas encimadas, no de mesas juntas", () => {
    const a = { id: "a", shape: "square" as const, placement: place({ x: 5, y: 5 }) };
    const pegada = { id: "b", shape: "square" as const, placement: place({ x: 6, y: 5 }) };
    const encima = { id: "c", shape: "square" as const, placement: place({ x: 5, y: 5 }) };
    const lejos = { id: "d", shape: "round" as const, placement: place({ x: 20, y: 20 }) };
    expect(findOverlaps([a, pegada, lejos]).size).toBe(0);
    expect([...findOverlaps([a, encima, lejos])].sort()).toEqual(["a", "c"]);
  });

  it("dos redondas en diagonal no se pisan aunque sus cajas sí", () => {
    const a = { id: "a", shape: "round" as const, placement: place({ x: 5, y: 5 }) };
    const b = { id: "b", shape: "round" as const, placement: place({ x: 5.8, y: 5.8 }) };
    expect(findOverlaps([a, b]).size).toBe(0);
    // Las mismas, cuadradas, sí.
    expect(
      findOverlaps([
        { ...a, shape: "square" as const },
        { ...b, shape: "square" as const },
      ]).size,
    ).toBe(2);
    expect(
      convexOverlapDepth(tableOutline("square", a.placement), tableOutline("square", b.placement)),
    ).toBeCloseTo(0.2);
  });

  it("la caja del plano envuelve zonas, elementos y mesas", () => {
    expect(sceneBounds({ zones: [], markers: [] }, [])).toBeNull();
    const box = sceneBounds({ zones: [barra], markers: [] }, [place({ x: 1, y: 8, w: 2, h: 2 })]);
    expect(box).toEqual({ x: 0, y: 0, w: 10, h: 9 });
  });

  it("el rótulo de una zona se ancla en su vértice superior izquierdo", () => {
    expect(
      zoneLabelAnchor([
        { x: 5, y: 3 },
        { x: 2, y: 1 },
        { x: 9, y: 1 },
        { x: 2, y: 8 },
      ]),
    ).toEqual({ x: 2, y: 1 });
  });
});

describe("tamaños y sillas por defecto", () => {
  it("la mesa crece con la capacidad", () => {
    const two = defaultTableSize("square", 2);
    const eight = defaultTableSize("square", 8);
    expect(eight.w).toBeGreaterThan(two.w);
    expect(defaultTableSize("round", 6).w).toBe(defaultTableSize("round", 6).h);
    const bar = defaultTableSize("bar", 6);
    expect(bar.w).toBeGreaterThan(bar.h * 4);
    for (const shape of ["square", "round", "bar"] as const) {
      for (const cap of [0, 1, 4, 12, 40, NaN]) {
        const s = defaultTableSize(shape, cap);
        expect(s.w).toBeGreaterThanOrEqual(TABLE_SIZE_MIN);
        expect(s.w).toBeLessThanOrEqual(TABLE_SIZE_MAX);
        expect(s.h).toBeGreaterThanOrEqual(TABLE_SIZE_MIN);
      }
    }
  });

  it("dibuja a lo sumo tantas sillas como la capacidad, y nunca fuera de lo que cabe", () => {
    expect(seatLayout("square", 0.9, 0.9, 4)).toHaveLength(4);
    expect(seatLayout("square", 0.7, 0.7, 2)).toHaveLength(2);
    expect(seatLayout("square", 0.7, 0.7, 10)).toHaveLength(4);
    expect(seatLayout("round", 1.25, 1.25, 6)).toHaveLength(6);
    // Barra: todas del mismo lado.
    const bar = seatLayout("bar", 2.3, 0.45, 4);
    expect(bar).toHaveLength(4);
    expect(new Set(bar.map((s) => s.y)).size).toBe(1);
    expect(seatLayout("square", 1, 1, 0)).toEqual([]);
  });
});

describe("proyección al formato viejo (para la versión anterior)", () => {
  const scene = sanitizeScene({
    zones: [
      { id: "t", kind: "terraza", label: "", points: rectPoints({ x: 2, y: 2, w: 4, h: 3 }) },
    ],
    markers: [
      { id: "e", kind: "entrada", x: 8.5, y: 4.5 },
      { id: "w", kind: "pared", x: 5, y: 5 },
    ],
  });

  it("da un blob que el parseo viejo acepta tal cual", () => {
    const tables = [
      { id: "a", number: 1, placement: place({ x: 2.6, y: 2.4, w: 0.4, h: 0.4 }) },
      { id: "b", number: 2, placement: place({ x: 4.5, y: 3.5, w: 0.4, h: 0.4 }) },
    ];
    const { plan, cells } = projectToLegacy(scene, tables);
    const reread = resolveLegacyFloorPlan(buildStoredFloorPlan(scene, plan));
    expect(reread).toEqual(plan);
    // El origen se corre al contenido: la zona arranca en la celda 0,0.
    expect(plan.zones[0].cells).toHaveLength(12);
    expect(plan.zones[0].cells[0]).toEqual({ x: 0, y: 0 });
    // Los elementos nuevos no existen en el plano viejo.
    expect(plan.markers.map((m) => m.kind)).toEqual(["entrada"]);
    expect(cells).toEqual({ a: { x: 0, y: 0 }, b: { x: 2, y: 1 } });
    expect(plan.cols).toBeGreaterThanOrEqual(7);
  });

  it("dos mesas en la misma celda no quedan una sobre otra", () => {
    const tables = [
      { id: "a", number: 1, placement: place({ x: 3.2, y: 3.2, w: 0.4, h: 0.4 }) },
      { id: "b", number: 2, placement: place({ x: 3.7, y: 3.6, w: 0.4, h: 0.4 }) },
      { id: "c", number: 3, placement: place({ x: 3.5, y: 3.4, w: 0.4, h: 0.4 }) },
    ];
    const { cells } = projectToLegacy({ zones: [], markers: [] }, tables);
    const keys = Object.values(cells).map((c) => `${c.x},${c.y}`);
    expect(new Set(keys).size).toBe(3);
  });

  it("ida y vuelta: viejo → libre → viejo conserva celdas y zonas", () => {
    const stored = {
      cols: 8,
      rows: 5,
      zones: [{ id: "z", kind: "jardin", label: "Jardín", cells: [...block(0, 0, 3, 2), { x: 0, y: 2 }] }],
      markers: [{ id: "m", kind: "banos", label: "WC", x: 7, y: 4 }],
    };
    const rows = [
      row({ id: "a", floorPlanX: 0, floorPlanY: 0 }),
      row({ id: "b", floorPlanX: 2, floorPlanY: 1 }),
      row({ id: "c", floorPlanX: 5, floorPlanY: 3 }),
    ];
    const { scene: s, placements } = resolveFloor(stored, rows);
    const { plan, cells } = projectToLegacy(
      s,
      rows.map((r, i) => ({ id: r.id, number: i + 1, placement: placements[r.id] })),
    );
    expect(cells).toEqual({ a: { x: 0, y: 0 }, b: { x: 2, y: 1 }, c: { x: 5, y: 3 } });
    const sortCells = (c: { x: number; y: number }[]) =>
      [...c].sort((p, q) => p.y - q.y || p.x - q.x);
    expect(sortCells(plan.zones[0].cells)).toEqual(sortCells(stored.zones[0].cells));
    expect(plan.markers[0]).toEqual({ id: "m", kind: "banos", label: "WC", x: 7, y: 4 });
    expect(plan.cols).toBe(8);
    expect(plan.rows).toBe(5);
  });
});
