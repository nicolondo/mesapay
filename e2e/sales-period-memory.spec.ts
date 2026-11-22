import { test, expect } from "@playwright/test";

test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });

const email = process.env.E2E_OPERATOR_EMAIL;
const password = process.env.E2E_OPERATOR_PASSWORD;
const base = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3300");
const sales = "/operator/reports/ventas";

test("restores the selected sales dates and time axis on a fresh menu visit", async ({ page }, info) => {
  test.skip(!email || !password || !["localhost", "127.0.0.1"].includes(base.hostname), "Requires a local demo operator");
  test.setTimeout(180_000);
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", url: base.origin }]);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const response = await page.request.post("/api/auth/callback/credentials", {
    headers: { "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: email!, password: password!, callbackUrl: base.origin + sales },
  });
  expect(response.ok()).toBe(true);
  const capture = async (name: string) => {
    await page.screenshot({ path: info.outputPath(name + ".png"), style: "nextjs-portal{display:none!important}" });
  };

  await page.goto(sales);
  const period = page.getByRole("combobox", { name: /^Período/ });
  const payment = page.getByRole("radio", { name: "Hora del pago" });
  await payment.click();
  await expect(payment).toBeChecked();
  await period.selectOption("rango");
  const from = page.getByLabel("Desde", { exact: true });
  const to = page.getByLabel("Hasta", { exact: true });
  await from.fill("2026-10-12");
  await to.fill("2026-10-18");
  await page.getByRole("button", { name: "Aplicar", exact: true }).click();
  await expect(page).toHaveURL(/hasta=2026-10-18/);
  await capture("01-rango");
  await page.goto("/operator");
  await expect(page).toHaveURL(/\/operator\/?$/);
  await capture("02-resumen");
  await page.goto(sales);
  await expect(period).toHaveValue("rango");
  await expect(from).toHaveValue("2026-10-12");
  await expect(to).toHaveValue("2026-10-18");
  await expect(payment).toBeChecked();
  await capture("03-restaurado");

  await page.goto(sales + "?comparar=no");
  await expect(period).toHaveValue("30d");
  await expect(page.getByRole("radio", { name: "Hora del pedido" })).toBeChecked();
  await period.selectOption("semana");
  await expect(page).toHaveURL(/periodo=semana/);
  await page.goto(sales);
  await expect(period).toHaveValue("semana");
  await period.selectOption("30d");
  await expect(page).toHaveURL(/periodo=30d/);
  await page.goto(sales);
  await expect(period).toHaveValue("30d");
});
