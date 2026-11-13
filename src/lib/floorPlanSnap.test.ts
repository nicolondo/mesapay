import { describe, expect, it } from "vitest";
import type { Box } from "./floorPlan";
import { alignDeltas, distributeDeltas, snapCoord, snapMove, snapTargets } from "./floorPlanSnap";

const box = (x: number, y: number, w = 1, h = 1): Box => ({ x, y, w, h });
const T = { threshold: 0.15 };

describe("guías inteligentes al mover", () => {
  it("pega el borde izquierdo al de otra mesa y dibuja la línea vertical", () => {
    const out = snapMove(box(2.08, 5), [box(2, 0)], T);
    expect(out.dx).toBeCloseTo(-0.08);
    expect(out.dy).toBe(0);
    expect(out.guides).toEqual([{ kind: "v", x: 2, y1: 0, y2: 6 }]);
  });

  it("alinea centros aunque los tamaños sean distintos", () => {
    // Centro de la otra: x = 3. La movida mide 2 → su centro en 3 es x = 2.
    const out = snapMove(box(2.1, 5, 2, 1), [box(2.5, 0, 1, 1)], T);
    expect(out.dx).toBeCloseTo(-0.1);
    expect(out.guides[0]).toMatchObject({ kind: "v", x: 3 });
  });

  it("no ajusta si no hay nada a tiro", () => {
    const out = snapMove(box(2.4, 5.4), [box(0, 0)], T);
    expect(out).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("continúa una fila con la misma separación", () => {
    // Dos mesas separadas 0.5; la tercera debe quedar a 0.5 de la segunda: x = 3.
    const out = snapMove(box(3.1, 0.3), [box(0, 0), box(1.5, 0)], { threshold: 0.15 });
    expect(out.dx).toBeCloseTo(-0.1);
    const gaps = out.guides.filter((g) => g.kind === "gap");
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ axis: "x", from: 1, to: 1.5 });
    expect(gaps[1]).toMatchObject({ axis: "x", from: 2.5, to: 3 });
  });

  it("centra entre dos vecinas", () => {
    const out = snapMove(box(1.6, 0.2), [box(0, 0), box(3, 0)], T);
    expect(out.dx).toBeCloseTo(-0.1); // queda en 1.5: 0.5 a cada lado
    expect(out.guides.filter((g) => g.kind === "gap")).toHaveLength(2);
  });

  it("la separación igual solo mira la misma fila", () => {
    const out = snapMove(box(3.1, 5), [box(0, 0), box(1.5, 0)], T);
    expect(out.dx).toBe(0);
  });

  it("con cuadrícula y nada cerca, ajusta la esquina a la cuadrícula", () => {
    const out = snapMove(box(10.1, 7.38), [box(0, 0)], { threshold: 0.05, grid: 0.25 });
    expect(out.dx).toBeCloseTo(-0.1);
    expect(out.dy).toBeCloseTo(0.12);
    expect(out.guides).toEqual([]);
  });

  it("una guía manda sobre la cuadrícula", () => {
    const out = snapMove(box(2.07, 5.1), [box(2.03, 0)], { threshold: 0.1, grid: 0.25 });
    expect(out.dx).toBeCloseTo(-0.04);
  });

  it("sigue estable con 100 mesas", () => {
    const many = Array.from({ length: 100 }, (_, i) => box((i % 10) * 1.5, Math.floor(i / 10) * 1.5));
    const out = snapMove(box(4.55, 20), many, T);
    expect(out.dx).toBeCloseTo(-0.05);
  });
});

describe("ajuste de una coordenada", () => {
  it("elige el objetivo más cercano dentro del umbral", () => {
    expect(snapCoord(2.06, [1, 2, 2.1], T)).toEqual({ v: 2.1, hit: 2.1 });
    expect(snapCoord(5, [1, 2], T)).toEqual({ v: 5, hit: null });
    expect(snapCoord(5.1, [1, 2], { threshold: 0.1, grid: 0.25 })).toEqual({ v: 5, hit: null });
  });

  it("los objetivos de una caja son inicio, centro y fin", () => {
    expect(snapTargets([box(1, 4, 2, 6)], "x")).toEqual([1, 2, 3]);
    expect(snapTargets([box(1, 4, 2, 6)], "y")).toEqual([4, 7, 10]);
  });
});

describe("alinear y distribuir", () => {
  const boxes = [box(0, 0, 1, 1), box(3, 2, 2, 1), box(7, 5, 1, 3)];

  it("alinea a la izquierda, al centro y abajo", () => {
    expect(alignDeltas(boxes, "left").map((d) => d.x)).toEqual([0, -3, -7]);
    expect(alignDeltas(boxes, "bottom").map((d) => d.y)).toEqual([7, 5, 0]);
    const centers = alignDeltas(boxes, "centerX").map((d, i) => boxes[i].x + d.x + boxes[i].w / 2);
    expect(new Set(centers).size).toBe(1);
    expect(alignDeltas([], "left")).toEqual([]);
  });

  it("distribuye con separación igual sin mover los extremos", () => {
    const row = [box(0, 0), box(1.2, 0), box(6, 0)];
    const d = distributeDeltas(row, "x");
    expect(d[0].x).toBe(0);
    expect(d[2].x).toBe(0);
    // Tramo 0..7, 3 mesas de 1 → 2 huecos de 2: la del medio va a x = 3.
    expect(row[1].x + d[1].x).toBeCloseTo(3);
  });

  it("con menos de 3 no mueve nada", () => {
    expect(distributeDeltas([box(0, 0), box(5, 0)], "x")).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
  });
});
