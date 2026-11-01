// Los datáfonos Kushki son del comercio, no de un mesero: nada del código
// debe seguir leyendo o escribiendo `TerminalDevice.assignedUserId` (la
// columna queda en la base sin uso) ni el helper que resolvía "el datáfono
// del mesero". Si alguien lo vuelve a usar, este test lo dice.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

describe("nadie depende del mesero asignado a un datáfono", () => {
  it("ningún archivo de src usa assignedUserId, getAssignedDevice ni meseroDevice (salvo en comentarios)", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/assignedUserId|getAssignedDevice|meseroDevice/.test(line) && !isComment(line)) {
            hits.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
});
