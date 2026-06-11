import { describe, it, expect } from "vitest";
import { readdirSync } from "fs";
import { join } from "path";

const DIR = join(import.meta.dirname ?? __dirname, ".");

interface CityDataset {
  country: string;
  name: string;
  complete: boolean;
  main: string[];
  cities: string[];
}

function loadDatasets(): { file: string; data: CityDataset }[] {
  const files = readdirSync(DIR).filter(
    (f) => f.endsWith(".json") && f !== "datasets.test.ts",
  );
  return files.map((file) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const data = require(join(DIR, file)) as CityDataset;
    return { file, data };
  });
}

describe("city datasets", () => {
  const datasets = loadDatasets();

  it("at least 10 dataset files exist", () => {
    expect(datasets.length).toBeGreaterThanOrEqual(10);
  });

  for (const { file, data } of datasets) {
    const code = file.replace(".json", "").toUpperCase();

    describe(`${file}`, () => {
      it("country code matches filename", () => {
        expect(data.country.toUpperCase()).toBe(code);
      });

      it("has a non-empty name field", () => {
        expect(typeof data.name).toBe("string");
        expect(data.name.length).toBeGreaterThan(0);
      });

      it("has at least 30 cities", () => {
        expect(data.cities.length).toBeGreaterThanOrEqual(30);
      });

      it("main cities ⊆ cities (mains must appear in cities list)", () => {
        const citySet = new Set(data.cities);
        for (const main of data.main) {
          expect(
            citySet.has(main),
            `main city "${main}" is missing from cities[]`,
          ).toBe(true);
        }
      });

      it("no duplicate cities", () => {
        const seen = new Set<string>();
        const dupes: string[] = [];
        for (const city of data.cities) {
          if (seen.has(city)) dupes.push(city);
          seen.add(city);
        }
        expect(dupes, `duplicate cities: ${dupes.join(", ")}`).toHaveLength(0);
      });

      it("has exactly 5 main cities", () => {
        expect(data.main).toHaveLength(5);
      });

      it("no duplicate main cities", () => {
        const mainSet = new Set(data.main);
        expect(mainSet.size).toBe(data.main.length);
      });
    });
  }
});
