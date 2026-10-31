import { describe, expect, it } from "vitest";
import { renderPasswordChangedEmail } from "./mailer";

describe("aviso de contraseña cambiada", () => {
  it.each(["es", "en", "pt"])("se arma en %s, escapa el HTML y no lleva token", async (locale) => {
    const out = await renderPasswordChangedEmail(
      { email: "admin@mesapay.co", name: "<img src=x onerror=alert(1)>" },
      locale,
    );
    expect(out.html).toContain(`lang="${locale}"`);
    expect(out.html).not.toContain("<img src=x");
    expect(out.subject).not.toMatch(/emailPasswordChanged/);
    expect(out.text).toContain("admin@mesapay.co");
    // Manda a "olvidé mi contraseña", nunca a un enlace con token.
    expect(out.html).toContain("/signin/olvide");
    expect(out.html).not.toContain("/restablecer/");
  });
});
