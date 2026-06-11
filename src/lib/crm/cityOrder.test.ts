import { describe, it, expect } from "vitest";
import { orderCities } from "./cityOrder";

describe("orderCities", () => {
  const cities = ["Zipaquirá", "Bogotá", "Cali", "Medellín", "Acacías", "Barranquilla", "Cartagena"];
  const main = ["Bogotá", "Medellín", "Cali", "Barranquilla", "Cartagena"];

  it("mains appear first in given order", () => {
    const result = orderCities(cities, main);
    expect(result.slice(0, 5)).toEqual(main);
  });

  it("non-main cities appear after mains, sorted alphabetically", () => {
    const result = orderCities(cities, main);
    const tail = result.slice(5);
    expect(tail).toEqual(["Acacías", "Zipaquirá"]);
  });

  it("mains not in cities list are skipped", () => {
    const result = orderCities(["Cali", "Zipaquirá"], ["Bogotá", "Cali"]);
    expect(result[0]).toBe("Cali");
    expect(result).not.toContain("Bogotá");
  });

  it("empty cities returns empty array", () => {
    expect(orderCities([], main)).toEqual([]);
  });

  it("empty main returns all cities sorted", () => {
    const result = orderCities(["Zipaquirá", "Acacías", "Cali"], []);
    expect(result).toEqual(["Acacías", "Cali", "Zipaquirá"]);
  });

  it("accented letters sort correctly (base sensitivity)", () => {
    const result = orderCities(["Úbeda", "acacias", "Bogotá"], []);
    // a < b < u ignoring accents
    expect(result[0].toLowerCase().replace(/[^a-z]/g, "")[0]).toBe("a");
    expect(result[1].toLowerCase().replace(/[^a-z]/g, "")[0]).toBe("b");
  });

  it("preserves all elements (no drops)", () => {
    const result = orderCities(cities, main);
    expect(result.length).toBe(cities.length);
    expect(new Set(result)).toEqual(new Set(cities));
  });
});
