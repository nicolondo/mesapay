// El Business-Code del Cloud Terminal no es el Merchant ID ni la llave
// pública de Kushki (Son y Melona, 2026-10-31: guardado el Merchant ID,
// cada cobro rebotaba con CLOUDPAYMENT_VALIDATION_ERROR).
import { describe, expect, it } from "vitest";
import { businessCodeProblem, maskBusinessCode } from "./businessCode";

const MERCHANT_ID = "6f1c0f7a2b9d4e3c8a5b1d2e3f4a5b6c";
const PUBLIC_KEY = "pk_live_9a8b7c6d5e4f3a2b1c0d";

describe("businessCodeProblem", () => {
  it("el Merchant ID no es un Business-Code (sin importar mayúsculas ni espacios)", () => {
    const creds = { kushkiMerchantId: MERCHANT_ID, kushkiPublicKey: PUBLIC_KEY };
    expect(businessCodeProblem(MERCHANT_ID, creds)).toBe("business_code_is_merchant_id");
    expect(businessCodeProblem(`  ${MERCHANT_ID.toUpperCase()} `, creds)).toBe("business_code_is_merchant_id");
  });

  it("la llave pública tampoco", () => {
    expect(businessCodeProblem(PUBLIC_KEY, { kushkiMerchantId: MERCHANT_ID, kushkiPublicKey: PUBLIC_KEY })).toBe(
      "business_code_is_public_key",
    );
  });

  it("un código distinto, o un comercio sin credenciales cargadas, pasa", () => {
    expect(businessCodeProblem("BC-55555", { kushkiMerchantId: MERCHANT_ID, kushkiPublicKey: PUBLIC_KEY })).toBeNull();
    expect(businessCodeProblem(MERCHANT_ID, { kushkiMerchantId: null, kushkiPublicKey: null })).toBeNull();
    expect(businessCodeProblem(null, { kushkiMerchantId: MERCHANT_ID })).toBeNull();
    expect(businessCodeProblem("", { kushkiMerchantId: "" })).toBeNull();
  });
});

describe("maskBusinessCode", () => {
  it("sólo muestra los últimos 4 caracteres (es una clave)", () => {
    expect(maskBusinessCode(MERCHANT_ID)).toBe("••••5b6c");
    expect(maskBusinessCode("  BC-55555 ")).toBe("••••5555");
  });

  it("uno muy corto no se muestra entero; vacío o null → null", () => {
    expect(maskBusinessCode("1234")).toBe("••••");
    expect(maskBusinessCode("")).toBeNull();
    expect(maskBusinessCode("   ")).toBeNull();
    expect(maskBusinessCode(null)).toBeNull();
  });
});
