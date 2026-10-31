import { describe, expect, it } from "vitest";
import es from "../../../messages/es.json";
import en from "../../../messages/en.json";
import pt from "../../../messages/pt.json";
import type { BlockerCode } from "./checks";
import {
  BLOCKER_ACTIONS,
  OPERATOR_DESTINATION_PATH,
  deleteGate,
  isBlockerAction,
  resolutionFor,
  type OperatorDestination,
} from "./resolution";

const ALL_BLOCKERS: BlockerCode[] = [
  "payments_pending",
  "payments_in_flight",
  "refunds_in_flight",
  "financial_operations_open",
  "payouts_in_flight",
  "payment_links_pending",
  "payment_links_in_flight",
  "dian_pending",
  "dian_error",
  "subscription_active",
  "cross_tenant_references",
];

describe("botón «Eliminar definitivamente» y campo del slug", () => {
  it("con bloqueos: el campo sigue editable y el motivo es resolver lo de arriba (aunque el slug ya coincida)", () => {
    for (const slugInput of ["", "da", "dani"]) {
      expect(deleteGate({ blockerCount: 2, slugInput, slug: "dani" })).toEqual({
        slugFieldDisabled: false,
        canDelete: false,
        reason: "blocked",
      });
    }
  });

  it.each(["", "dan", "DANI", "dani ", " dani"])("sin bloqueos y slug %j → hay que escribir el slug exacto", (slugInput) => {
    expect(deleteGate({ blockerCount: 0, slugInput, slug: "dani" })).toEqual({
      slugFieldDisabled: false,
      canDelete: false,
      reason: "slug_mismatch",
    });
  });

  it("sin bloqueos y slug exacto → se habilita, sin motivo", () => {
    expect(deleteGate({ blockerCount: 0, slugInput: "dani", slug: "dani" })).toEqual({
      slugFieldDisabled: false,
      canDelete: true,
      reason: null,
    });
  });
});

describe("cómo se resuelve cada bloqueo", () => {
  it("sólo lo que tiene una transición segura ofrece una acción", () => {
    const withAction = ALL_BLOCKERS.filter((code) => resolutionFor(code).kind === "action");
    expect(withAction.sort()).toEqual(["payment_links_pending", "payments_pending", "subscription_active"]);
    expect(resolutionFor("payments_pending")).toEqual({ kind: "action", action: "decline_pending_payments" });
    expect(resolutionFor("payment_links_pending")).toEqual({ kind: "action", action: "cancel_payment_links" });
    expect(resolutionFor("subscription_active")).toEqual({ kind: "action", action: "cancel_subscription" });
  });

  it("plata en vuelo, estados inciertos y DIAN no se fuerzan nunca desde el diálogo", () => {
    for (const code of [
      "payments_in_flight",
      "refunds_in_flight",
      "financial_operations_open",
      "payouts_in_flight",
      "payment_links_in_flight",
      "dian_pending",
      "dian_error",
      "cross_tenant_references",
    ] as const) {
      expect(resolutionFor(code).kind).not.toBe("action");
    }
  });

  it("los documentos DIAN llevan a Facturas del comercio", () => {
    expect(resolutionFor("dian_pending")).toEqual({ kind: "operator", destination: "invoices" });
    expect(resolutionFor("dian_error")).toEqual({ kind: "operator", destination: "invoices" });
    expect(OPERATOR_DESTINATION_PATH.invoices).toBe("/operator/facturas");
  });

  it("reconoce sólo las acciones conocidas", () => {
    for (const action of BLOCKER_ACTIONS) expect(isBlockerAction(action)).toBe(true);
    expect(isBlockerAction("delete")).toBe(false);
    expect(isBlockerAction(undefined)).toBe(false);
  });
});

describe("textos del diálogo en es / en / pt", () => {
  const catalogs = { es, en, pt } as Record<string, { adminDelete: Record<string, string> }>;
  const destinations = Object.keys(OPERATOR_DESTINATION_PATH) as OperatorDestination[];
  const required = [
    ...ALL_BLOCKERS.map((code) => `blocker_${code}`),
    ...BLOCKER_ACTIONS.flatMap((a) => [`action_${a}`, `confirm_${a}`, `confirmYes_${a}`, `running_${a}`]),
    ...destinations.map((d) => `goto_${d}`),
    "reason_blocked",
    "reason_slug_mismatch",
    "actionBack",
    "actionError_generic",
    "opening",
    "openFailed",
    "subscriptionError_billing_not_configured",
    "subscriptionError_provider_rejected",
    "subscriptionError_provider_unavailable",
  ];

  it.each(Object.keys(catalogs))("%s tiene todas las claves", (locale) => {
    const ns = catalogs[locale].adminDelete;
    expect(required.filter((key) => typeof ns[key] !== "string" || ns[key].length === 0)).toEqual([]);
  });

  it("los motivos del botón son los pedidos", () => {
    expect(es.adminDelete.reason_blocked).toBe("Resuelve lo de arriba para poder eliminar");
    expect(es.adminDelete.reason_slug_mismatch).toBe("Escribe el slug exacto");
  });
});
