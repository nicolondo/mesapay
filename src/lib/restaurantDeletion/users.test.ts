import { describe, expect, it } from "vitest";
import type { Prisma, Role } from "@prisma/client";
import { fakeClient } from "@/test/fakeDeletionClient";
import { planUsers, usersWithForeignReferences } from "./users";

describe("planUsers", () => {
  const all: { id: string; role: Role }[] = [
    { id: "admin", role: "platform_admin" },
    { id: "group", role: "group_admin" },
    { id: "rep", role: "comercial" },
    { id: "boss", role: "gerente_comercial" },
    { id: "op", role: "operator" },
    { id: "mesero", role: "mesero" },
    { id: "cocina", role: "kitchen" },
    { id: "bar", role: "bar" },
    { id: "pos", role: "terminal" },
    { id: "legacy", role: "customer" },
  ];

  it("borra el personal, desvincula la plataforma y nunca borra un platform_admin", () => {
    const plan = planUsers(all, new Set());
    expect(plan.deleteIds.sort()).toEqual(["bar", "cocina", "legacy", "mesero", "op", "pos"]);
    expect(plan.detachIds.sort()).toEqual(["admin", "boss", "group", "rep"]);
    expect(plan.disableIds).toEqual([]);
  });

  it("un rol desconocido (nuevo, sin clasificar) se desvincula, no se borra", () => {
    const plan = planUsers([{ id: "x", role: "superhero" as Role }], new Set());
    expect(plan).toEqual({ deleteIds: [], detachIds: ["x"], disableIds: [] });
  });

  it("el personal con referencias de afuera se desactiva; la plataforma se desvincula aunque las tenga", () => {
    const plan = planUsers(all, new Set(["op", "admin"]));
    expect(plan.disableIds).toEqual(["op"]);
    expect(plan.detachIds).toContain("admin");
    expect(plan.deleteIds).not.toContain("op");
    expect(plan.deleteIds).not.toContain("admin");
  });
});

describe("usersWithForeignReferences", () => {
  it("sólo cuenta filas que NO se borran con el comercio y omite lo que se va con el usuario", async () => {
    const fake = fakeClient({
      select: (model, args) => (model === "shift" && args.distinct?.[0] === "openedById" ? [{ openedById: "op" }] : []),
    });
    const found = await usersWithForeignReferences(fake.client as unknown as Prisma.TransactionClient, "r1", ["op", "mesero"]);
    expect([...found.entries()]).toEqual([["op", ["Shift.openedById"]]]);

    const queried = fake.calls.filter((c) => c.method === "findMany");
    const shift = queried.find((c) => c.model === "shift" && c.args.distinct?.[0] === "openedById")!;
    // Turnos de OTROS comercios: los del comercio se borran con él.
    expect(shift.args.where).toEqual({ openedById: { in: ["op", "mesero"] }, NOT: { restaurantId: "r1" } });
    // Un hijo sin restaurantId propio se filtra por la cadena de dueños.
    const round = queried.find((c) => c.model === "round")!;
    expect(round.args.where).toEqual({ placedByUserId: { in: ["op", "mesero"] }, NOT: { order: { restaurantId: "r1" } } });
    // El CRM se conserva: cualquier fila es ajena.
    const lead = queried.find((c) => c.model === "crmLead")!;
    expect(lead.args.where).not.toHaveProperty("NOT");
    // Lo del propio usuario (tokens, push, correo CRM) no cuenta.
    for (const own of ["passwordResetToken", "pushSubscription", "crmEmailAccount"]) {
      expect(queried.some((c) => c.model === own), own).toBe(false);
    }
    // User.managerId: otro usuario del lote no es ajeno.
    const managed = queried.find((c) => c.model === "user")!;
    expect(managed.args.where).toEqual({ managerId: { in: ["op", "mesero"] }, id: { notIn: ["op", "mesero"] } });
  });
});
