import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { renderPasswordResetEmail } from "./mailer";
import {
  generateResetToken,
  hashResetToken,
  PENDING_PASSWORD_HASH,
} from "./passwordReset";

describe("restaurant welcome", () => {
  it.each(["es", "en", "pt"])(
    "renders a password invitation in %s without exposing HTML",
    async (locale) => {
      const out = await renderPasswordResetEmail(
        "<img src=x onerror=alert(1)>",
        "https://mesapay.co/restablecer/test-token",
        locale,
        "Cafe <script>bad</script>",
      );
      expect(out.html).toContain(`lang="${locale}"`);
      expect(out.html).not.toContain("<script>bad</script>");
      expect(out.html).not.toContain("<img src=x");
      expect(out.text).toContain("Cafe <script>bad</script>");
      expect(out.text).toContain("24");
      expect(out.html).toContain("https://mesapay.co/restablecer/test-token");
    },
  );
  it("cannot authenticate an invitation with a guessed password", async () => {
    expect(
      await bcrypt.compare(PENDING_PASSWORD_HASH, PENDING_PASSWORD_HASH),
    ).toBe(false);
  });
  it("stores a digest rather than the usable invitation", () => {
    const token = generateResetToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(hashResetToken(token)).not.toBe(token);
  });
});
