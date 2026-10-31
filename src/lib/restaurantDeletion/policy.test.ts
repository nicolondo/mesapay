import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { RESTAURANT_MODEL, tenantModel, tenantModels } from "@/lib/backups/tables";
import {
  ARCHIVE_REDACTED_FIELDS,
  FOREIGN_UPLOAD_COLUMNS,
  PLATFORM_MODEL_POLICY,
  PLATFORM_ROLES,
  SECRET_FIELD_PATTERN,
  STAFF_ROLES,
  UNRELATED_MODELS,
  UPLOAD_COLUMNS,
  tenantDeletionWhere,
} from "./policy";
import { modelsThatMustBeEmpty } from "./checks";

const models = Prisma.dmmf.datamodel.models;
const tenant = new Set(tenantModels().map((m) => m.name));
const hasRestaurantId = (name: string) =>
  models.find((m) => m.name === name)!.fields.some((f) => f.kind === "scalar" && f.name === "restaurantId");
const relationsOf = (name: string) =>
  models
    .find((m) => m.name === name)!
    .fields.filter((f) => f.kind === "object" && !f.isList && (f.relationFromFields?.length ?? 0) > 0);

describe("cobertura de modelos al eliminar un comercio", () => {
  it("todo modelo del esquema está clasificado exactamente una vez (una tabla nueva rompe este test)", () => {
    for (const m of models) {
      const places = [
        m.name === RESTAURANT_MODEL,
        tenant.has(m.name),
        m.name in PLATFORM_MODEL_POLICY,
        m.name in UNRELATED_MODELS,
      ].filter(Boolean).length;
      expect(places, `${m.name}: clasificalo en policy.ts (tenant, PLATFORM_MODEL_POLICY o UNRELATED_MODELS)`).toBe(1);
    }
    // El archivo final NO puede ser "del comercio": se borraría con él.
    expect(tenant.has("DeletedRestaurantArchive")).toBe(false);
    for (const name of [...Object.keys(PLATFORM_MODEL_POLICY), ...Object.keys(UNRELATED_MODELS)]) {
      expect(models.some((m) => m.name === name), `${name} ya no existe en el esquema`).toBe(true);
    }
  });

  it("todo modelo con restaurantId o relación al comercio tiene una política explícita", () => {
    for (const m of models) {
      if (m.name === RESTAURANT_MODEL) continue;
      const related = hasRestaurantId(m.name) || relationsOf(m.name).some((f) => f.type === RESTAURANT_MODEL);
      if (!related) continue;
      expect(tenant.has(m.name) || m.name in PLATFORM_MODEL_POLICY, m.name).toBe(true);
      expect(m.name in UNRELATED_MODELS, m.name).toBe(false);
    }
  });

  it("los modelos 'sin relación' no apuntan al comercio ni a sus tablas, ni por FK ni por un *Id suelto", () => {
    const tenantIdFields = new Set([...tenant].map((n) => `${n.charAt(0).toLowerCase()}${n.slice(1)}Id`));
    for (const name of Object.keys(UNRELATED_MODELS)) {
      expect(hasRestaurantId(name), name).toBe(false);
      for (const rel of relationsOf(name)) {
        expect(rel.type === RESTAURANT_MODEL || tenant.has(rel.type), `${name}.${rel.name} → ${rel.type}`).toBe(false);
      }
      const fields = models.find((m) => m.name === name)!.fields;
      for (const f of fields) {
        if (f.kind !== "scalar" || !tenantIdFields.has(f.name)) continue;
        const backedByRelation = relationsOf(name).some((r) => r.relationFromFields?.includes(f.name));
        expect(backedByRelation, `${name}.${f.name} parece una referencia sin FK a una tabla del comercio`).toBe(true);
      }
    }
  });

  it("lo que se conserva (detach) tiene la FK al comercio en SetNull y nullable", () => {
    for (const [name, policy] of Object.entries(PLATFORM_MODEL_POLICY)) {
      if (policy.action !== "detach") continue;
      const rel = relationsOf(name).find((f) => f.type === RESTAURANT_MODEL);
      expect(rel?.relationOnDelete, name).toBe("SetNull");
      const scalar = models.find((m) => m.name === name)!.fields.find((f) => f.name === "restaurantId");
      expect(scalar?.isRequired, name).toBe(false);
    }
    expect(PLATFORM_MODEL_POLICY.MembershipPayment.action).toBe("detach");
    expect(PLATFORM_MODEL_POLICY.CommissionEntry.action).toBe("detach");
    expect(PLATFORM_MODEL_POLICY.AuditEvent.action).toBe("detach");
    expect(PLATFORM_MODEL_POLICY.CrmLead.action).toBe("detach");
  });

  it("lo que se borra por política se puede ubicar por restaurantId (o es FinancialOperation, por paymentId)", () => {
    for (const [name, policy] of Object.entries(PLATFORM_MODEL_POLICY)) {
      if (policy.action !== "delete") continue;
      expect(hasRestaurantId(name) || name === "FinancialOperation", name).toBe(true);
    }
  });

  it("ninguna tabla que se conserva tiene una FK a una tabla del comercio que la arrastre o la trabe", () => {
    for (const m of models) {
      if (tenant.has(m.name) || m.name === RESTAURANT_MODEL) continue;
      const policy = PLATFORM_MODEL_POLICY[m.name];
      if (policy && (policy.action === "delete" || policy.action === "with_owner")) continue;
      for (const rel of relationsOf(m.name)) {
        if (!tenant.has(rel.type)) continue;
        expect(rel.relationOnDelete, `${m.name}.${rel.name} → ${rel.type}`).toBe("SetNull");
      }
    }
  });

  it("el DELETE final del comercio no arrastra nada en cascada: todo lo que cascadea o restringe se vació antes", () => {
    const mustBeEmpty = new Set(modelsThatMustBeEmpty());
    // Toda FK hacia el comercio se llama restaurantId (así la ubican el borrado y la verificación final).
    for (const m of models) {
      for (const rel of relationsOf(m.name)) {
        if (rel.type === RESTAURANT_MODEL && m.name !== RESTAURANT_MODEL) {
          expect(rel.relationFromFields, `${m.name}.${rel.name}`).toEqual(["restaurantId"]);
        }
      }
    }
    for (const m of models) {
      const rel = relationsOf(m.name).find((f) => f.type === RESTAURANT_MODEL && f.relationFromFields?.[0] === "restaurantId");
      if (!rel) continue;
      if (rel.relationOnDelete === "SetNull") {
        expect(PLATFORM_MODEL_POLICY[m.name]?.action, m.name).toBe("detach");
      } else {
        expect(mustBeEmpty.has(m.name), `${m.name} (${rel.relationOnDelete ?? "Restrict"})`).toBe(true);
      }
    }
    // El caso RESTRICT conocido y los de plataforma que se borran.
    for (const name of ["CreditNote", "User", "KushkiDocument", "DianConfig", "BillingSubscription", "RestaurantBackup", "PlatformEvent", "PushSubscription"]) {
      expect(mustBeEmpty.has(name), name).toBe(true);
    }
    for (const name of ["AuditEvent", "MembershipPayment", "CommissionEntry", "CrmLead", "KushkiWebhookEvent"]) {
      expect(mustBeEmpty.has(name), name).toBe(false);
    }
  });
});

describe("roles", () => {
  it("cada rol del enum está en exactamente una lista, y platform_admin nunca es personal del comercio", () => {
    const roles = Prisma.dmmf.datamodel.enums.find((e) => e.name === "Role")!.values.map((v) => v.name);
    for (const role of roles) {
      const n = [STAFF_ROLES.includes(role as never), PLATFORM_ROLES.includes(role as never)].filter(Boolean).length;
      expect(n, role).toBe(1);
    }
    expect(PLATFORM_ROLES).toEqual(expect.arrayContaining(["platform_admin", "group_admin", "comercial", "gerente_comercial"]));
    expect(STAFF_ROLES).not.toContain("platform_admin");
  });
});

describe("archivos y secretos", () => {
  it("toda columna *Url del esquema está clasificada como archivo del comercio o ajeno", () => {
    const listed = new Set([...UPLOAD_COLUMNS, ...FOREIGN_UPLOAD_COLUMNS].map((c) => `${c.model}.${c.field}`));
    for (const m of models) {
      for (const f of m.fields) {
        if (f.kind === "scalar" && f.type === "String" && /url$/i.test(f.name)) {
          expect(listed.has(`${m.name}.${f.name}`), `${m.name}.${f.name}`).toBe(true);
        }
      }
    }
    for (const key of listed) {
      const [model, field] = key.split(".");
      expect(models.find((m) => m.name === model)?.fields.some((f) => f.name === field), key).toBe(true);
    }
    // Las facturas de compra son soporte contable: se conservan en el archivo.
    expect(UPLOAD_COLUMNS.find((c) => c.model === "PurchaseInvoiceUpload")?.archive).toBe("purchase-invoices");
  });

  it("ningún hash de contraseña/token ni credencial cifrada de una tabla archivada llega al archivo", () => {
    const archived = new Set([RESTAURANT_MODEL, ...tenant]);
    for (const [name, policy] of Object.entries(PLATFORM_MODEL_POLICY)) {
      if (policy.action !== "with_owner" && policy.archive) archived.add(name);
    }
    for (const name of archived) {
      for (const f of models.find((m) => m.name === name)!.fields) {
        if (f.kind === "object" || !SECRET_FIELD_PATTERN.test(f.name)) continue;
        expect(ARCHIVE_REDACTED_FIELDS[name] ?? [], `${name}.${f.name}`).toContain(f.name);
      }
    }
    for (const [name, fields] of Object.entries(ARCHIVE_REDACTED_FIELDS)) {
      for (const field of fields) {
        expect(models.find((m) => m.name === name)?.fields.some((f) => f.name === field), `${name}.${field}`).toBe(true);
      }
    }
  });
});

describe("where del borrado", () => {
  it("usa restaurantId directo, la cadena de dueños para los hijos y ambas puntas en los alias", () => {
    expect(tenantDeletionWhere(tenantModel("Order")!, "r1")).toEqual({ restaurantId: "r1" });
    expect(tenantDeletionWhere(tenantModel("IngredientBarcode")!, "r1")).toEqual({ restaurantId: "r1" });
    expect(tenantDeletionWhere(tenantModel("OrderItem")!, "r1")).toEqual({ order: { restaurantId: "r1" } });
    expect(tenantDeletionWhere(tenantModel("SupplierInvoiceAlias")!, "r1")).toEqual({
      OR: [{ supplier: { restaurantId: "r1" } }, { ingredient: { restaurantId: "r1" } }],
    });
  });
});
