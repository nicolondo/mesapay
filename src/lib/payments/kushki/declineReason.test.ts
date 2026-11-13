// Código de rechazo de Kushki → motivo que la pantalla traduce.
import { describe, expect, it } from "vitest";
import es from "../../../../messages/es.json";
import en from "../../../../messages/en.json";
import pt from "../../../../messages/pt.json";
import { declineReasonForCode, KNOWN_DECLINE_CODES, type KushkiDeclineReason } from "./declineReason";

describe("declineReasonForCode", () => {
  it("K322 (antifraude de Kushki) → security_rejected", () => {
    expect(declineReasonForCode("K322")).toBe("security_rejected");
  });

  it("los códigos del emisor conservan su motivo", () => {
    expect(declineReasonForCode("022")).toBe("card_cvv");
    expect(declineReasonForCode("021")).toBe("card_funds");
    expect(declineReasonForCode("017")).toBe("card_invalid");
    expect(declineReasonForCode("023")).toBe("card_blocked");
    expect(declineReasonForCode("K040")).toBe("merchant_config");
  });

  it("lo desconocido es genérico; el token ya usado (577) no tiene motivo de rechazo", () => {
    expect(declineReasonForCode("K999")).toBe("charge_failed");
    expect(declineReasonForCode(null)).toBe("charge_failed");
    expect(declineReasonForCode("577")).toBe("charge_failed");
    expect(KNOWN_DECLINE_CODES.has("577")).toBe(false);
  });
});

describe("catálogo chargeDecline", () => {
  const REASONS: KushkiDeclineReason[] = [
    "security_rejected",
    "card_cvv",
    "card_funds",
    "card_invalid",
    "card_blocked",
    "merchant_config",
    "charge_failed",
  ];

  it("cada motivo (y `uncertain`) tiene texto en es, en y pt", () => {
    for (const catalog of [es, en, pt]) {
      const texts = catalog.chargeDecline as Record<string, string>;
      for (const reason of [...REASONS, "uncertain"]) expect(texts[reason], reason).toBeTruthy();
      expect(Object.keys(texts).sort()).toEqual([...REASONS, "uncertain"].sort());
    }
  });
});
