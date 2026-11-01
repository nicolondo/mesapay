import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

const publicFile = readFileSync(
  path.join(process.cwd(), "public/.well-known/apple-developer-merchantid-domain-association"),
  "utf8",
);

describe("Apple Pay domain association", () => {
  it("la ruta y el archivo de public/ sirven exactamente el mismo token", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(publicFile);
  });

  it("es el hex de Kushki, sin saltos de línea ni espacios, con el pspId de producción esperado", () => {
    expect(publicFile).toMatch(/^[0-9a-f]+$/);
    const decoded = JSON.parse(Buffer.from(publicFile, "hex").toString("utf8"));
    expect(decoded).toEqual({
      version: 1,
      pspId: "E39FE85D171B2F917389F5286FDAFEF8C4FBA4DDDF01B100F1AF67B0D8C7705D",
      createdOn: 1763752422865,
    });
  });
});
