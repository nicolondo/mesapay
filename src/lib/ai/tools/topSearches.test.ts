import { describe, it, expect } from "vitest";
import { aggregateSearches, type SearchRow } from "./topSearches";

const rows: SearchRow[] = [
  { term: "pizza", hadResults: true },
  { term: "pizza", hadResults: true },
  { term: "sushi", hadResults: false },
  { term: "sushi", hadResults: false },
  { term: "vino", hadResults: true },
];

describe("aggregateSearches", () => {
  it("cuenta por término y % sin resultados, ordena por count desc", () => {
    const r = aggregateSearches(rows, { limit: 10 });
    expect(r.terms[0]).toEqual({ term: "pizza", count: 2, noResultsPct: 0 });
    expect(r.terms).toContainEqual({ term: "sushi", count: 2, noResultsPct: 100 });
    expect(r.totalSearches).toBe(5);
  });
  it("separa los términos sin resultados más frecuentes", () => {
    const r = aggregateSearches(rows, { limit: 10 });
    expect(r.topNoResults[0]).toEqual({ term: "sushi", count: 2 });
  });
});
