import { describe, it, expect } from "vitest";
import { splitCsvLine, sniffDelimiter, parseCsv } from "./csv";

// ── splitCsvLine ─────────────────────────────────────────────────────────────

describe("splitCsvLine", () => {
  it("splits a simple comma-delimited line", () => {
    expect(splitCsvLine("a,b,c", ",")).toEqual(["a", "b", "c"]);
  });

  it("splits a semicolon-delimited line", () => {
    expect(splitCsvLine("a;b;c", ";")).toEqual(["a", "b", "c"]);
  });

  it("handles quoted fields", () => {
    expect(splitCsvLine('"hello world",b,c', ",")).toEqual([
      "hello world",
      "b",
      "c",
    ]);
  });

  it("handles escaped quotes inside quoted fields", () => {
    expect(splitCsvLine('"say ""hi""",b', ",")).toEqual(['say "hi"', "b"]);
  });

  it("handles quoted field with comma inside", () => {
    expect(splitCsvLine('"Bogotá, Cundinamarca",b', ",")).toEqual([
      "Bogotá, Cundinamarca",
      "b",
    ]);
  });

  it("trims unquoted fields", () => {
    expect(splitCsvLine("  a , b , c ", ",")).toEqual(["a", "b", "c"]);
  });

  it("handles empty fields", () => {
    expect(splitCsvLine("a,,c", ",")).toEqual(["a", "", "c"]);
  });

  it("handles trailing delimiter", () => {
    expect(splitCsvLine("a,b,", ",")).toEqual(["a", "b", ""]);
  });
});

// ── sniffDelimiter ───────────────────────────────────────────────────────────

describe("sniffDelimiter", () => {
  it("returns comma when more commas", () => {
    expect(sniffDelimiter("nombre,ciudad,telefono,email")).toBe(",");
  });

  it("returns semicolon when more semicolons", () => {
    expect(sniffDelimiter("nombre;ciudad;telefono;email")).toBe(";");
  });

  it("defaults to comma on tie", () => {
    expect(sniffDelimiter("a,b;c")).toBe(",");
  });

  it("handles header with no delimiters — defaults to comma", () => {
    expect(sniffDelimiter("nombre")).toBe(",");
  });
});

// ── parseCsv ─────────────────────────────────────────────────────────────────

describe("parseCsv", () => {
  it("parses a simple comma CSV", () => {
    const csv = "nombre,ciudad,telefono\nRestaurante ABC,Bogotá,3001234567";
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual(["nombre", "ciudad", "telefono"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      nombre: "Restaurante ABC",
      ciudad: "Bogotá",
      telefono: "3001234567",
    });
  });

  it("parses a semicolon CSV", () => {
    const csv = "nombre;ciudad;telefono\nCafé Patio;Medellín;3119876543";
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual(["nombre", "ciudad", "telefono"]);
    expect(rows[0].nombre).toBe("Café Patio");
  });

  it("normalizes headers to lowercase", () => {
    const csv = "Nombre,Ciudad,Teléfono\nTest,Cali,123";
    const { headers } = parseCsv(csv);
    expect(headers[0]).toBe("nombre");
  });

  it("tolerates missing columns — fills with empty string", () => {
    const csv = "nombre,ciudad,telefono,email\nRestaurante X,Cali";
    const { rows } = parseCsv(csv);
    expect(rows[0].email).toBe("");
    expect(rows[0].telefono).toBe("");
  });

  it("skips blank lines", () => {
    const csv = "nombre,ciudad\n\nRestaurante A,Bogotá\n\nRestaurante B,Cali\n";
    const { rows } = parseCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it("returns empty result for empty input", () => {
    const { headers, rows } = parseCsv("");
    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const csv = "nombre,ciudad\r\nRestaurante A,Bogotá\r\n";
    const { rows } = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].ciudad).toBe("Bogotá");
  });

  it("handles quoted fields with commas", () => {
    const csv = `nombre,ciudad\n"Restaurante, El Patio",Bogotá`;
    const { rows } = parseCsv(csv);
    expect(rows[0].nombre).toBe("Restaurante, El Patio");
  });

  it("caps at 501 data rows", () => {
    const header = "nombre,ciudad";
    const dataLines = Array.from({ length: 600 }, (_, i) => `Lead ${i},Bogotá`);
    const csv = [header, ...dataLines].join("\n");
    const { rows } = parseCsv(csv);
    expect(rows.length).toBe(501);
  });
});
