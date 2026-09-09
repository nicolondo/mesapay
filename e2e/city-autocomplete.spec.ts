import { test, expect } from "@playwright/test";

test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Local UI regression only");

for (const width of [390, 1440]) {
  test(`restaurant city selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/countries", (r) => r.fulfill({ json: { countries: [{ code: "CO" }, { code: "MX" }] } }));
    await page.goto("/signup/restaurant");
    const city = page.getByRole("combobox", { name: "Ciudad", exact: true });
    await city.fill("medellin");
    await expect(page.getByRole("option", { name: /Medellín, Antioquia/ })).toBeVisible();
    await city.press("Enter");
    await expect(city).toHaveValue("Medellín, Antioquia");
    await expect(page.getByRole("combobox", { name: "País", exact: true })).toHaveValue("CO");

    await page.getByPlaceholder("La Cocina de Mamá").fill("Fixture city");
    await page.locator('form > input[type="text"]').last().fill("Fixture Owner");
    await page.locator('input[type="email"]').fill("city@example.test");
    await page.locator('input[type="password"]').fill("FixturePassword123");
    let submitted: Record<string, unknown> | undefined;
    await page.route("**/api/auth/register-restaurant", (r) => {
      submitted = r.request().postDataJSON();
      return r.fulfill({ status: 400, json: { error: "Fixture: no restaurant created" } });
    });
    await page.getByRole("button", { name: "Crear restaurante", exact: true }).click();
    await expect.poll(() => submitted?.city).toBe("Medellín");
    expect(submitted?.country).toBe("CO");

    await page.getByRole("combobox", { name: "País", exact: true }).selectOption("MX");
    const foreignCity = page.getByRole("textbox", { name: "Ciudad", exact: true });
    await expect(foreignCity).toHaveValue("");
    await foreignCity.fill("Monterrey");
    await page.getByRole("combobox", { name: "País", exact: true }).selectOption("CO");
    await expect(city).toHaveValue("");

    await page.route("**/api/dane/municipios?**", (r) => r.fulfill({ status: 503, json: {} }));
    await city.fill("cali");
    await expect(page.getByRole("alert").filter({ hasText: "No pudimos cargar" })).toContainText("No pudimos cargar");
    await page.unroute("**/api/dane/municipios?**");
    await city.fill("envigado");
    await page.getByRole("option", { name: /Envigado, Antioquia/ }).click();
    await expect(city).toHaveValue("Envigado, Antioquia");
    await page.getByRole("button", { name: "Quitar", exact: true }).click();
    await expect(city).toHaveValue("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
