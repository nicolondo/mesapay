import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { TrackingView } from "../src/lib/walletTracking/contracts";

const app = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(app.hostname) || !["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname), "Only isolated local wallet tracking is allowed");
test.setTimeout(90_000);
const db = new PrismaClient();
const users = new Set<string>(), restaurants = new Set<string>();
type Surface = "admin" | "operator";
const freshView = (): TrackingView => ({
 historicalChangeToken: null, trackingId: "tracking-a", trackingKey: "key-a", mode: "production", currency: "COP", startedAt: "2026-11-10T15:00:00Z", excludesEarlier: true,
 baselineAvailableCents: 1_000_000, openingPendingCents: 0, snapshotAt: "2026-11-10T15:05:00Z", lastComparedAt: "2026-11-10T15:05:00Z", status: "active",
 estimatedPendingCents: 250_030, signedDifferenceCents: 250_030,
 totals: { chargesCents: 250_030, refundsCents: 0, registeredFeesCents: 0, effectiveOutgoingCents: 0, adjustmentsCents: 0, incorporatedHistoryCents: 0 },
 ambiguousOutgoingCount: 0, excludedSourceCount: 0, reasons: ["earlier_excluded", "fees_not_automatically_known"],
});
async function fixture(page: Page, surface: Surface) {
 const uuid = randomUUID(); let restaurantId: string | null = null;
 if (surface === "operator") { restaurantId = (await db.restaurant.create({ data: { name: "Seguimiento de prueba", slug: "wallet-track-" + uuid, country: "CO", kushkiMerchantId: "local-only", kushkiOnboardingStatus: "active", bankInfo: { bankName: "Banco de prueba", accountType: "ahorros", accountNumber: "123456789", holderName: "Persona de prueba", holderDocType: "NIT", holderDocNumber: "901000000" } } })).id; restaurants.add(restaurantId); }
 const user = await db.user.create({ data: { restaurantId, role: surface === "admin" ? "platform_admin" : "operator", email: "wallet-track-" + uuid + "@example.test", passwordHash: await bcrypt.hash(uuid, 4) } }); users.add(user.id);
 await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
 await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: app.hostname, path: "/" }]);
 const csrf = await (await page.request.get("/api/auth/csrf")).json();
 await page.request.post("/api/auth/callback/credentials", { headers: { "X-Auth-Return-Redirect": "1", "x-real-ip": "127.8." + parseInt(uuid.slice(0,2),16) + "." + parseInt(uuid.slice(2,4),16) }, form: { csrfToken: csrf.csrfToken, email: user.email, password: uuid, callbackUrl: app.origin + "/" + surface + "/wallet" } });
 expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
 let view = freshView(), balanceFail = false, trackingFail = false, loseNext = false, wrongScope = false, rejectHistoricalOnce = false;
 const accountId = "wallet-a", context = surface === "admin" ? { accountId } : { restaurantId };
 const submissions: Record<string, unknown>[] = [], applied = new Set<string>(); let incomingCalls = 0, payoutCalls = 0;
 await page.route("**/api/" + surface + "/wallet/balance", route => route.fulfill({ status: balanceFail ? 502 : 200, json: balanceFail ? { error: "balance_failed" } : { accountId, availableCents: 0, currency: "COP", queriedAt: "2026-11-10T15:05:00Z", pendingCents: null, pendingStatus: "not_reported", pendingUpdatedAt: null, balanceDate: null } }));
 await page.route("**/api/" + surface + "/wallet/banks", route => route.fulfill({ json: { accountId, banks: [{ id: "1007", name: "Banco de prueba" }] } }));
 await page.route("**/api/" + surface + "/wallet/payouts*", route => { if (route.request().method() !== "GET") payoutCalls++; return route.fulfill({ json: { payouts: [], nextCursor: null } }); });
 await page.route("**/api/operator/wallet/disperse*", route => { payoutCalls++; return route.fulfill({ status: 409, json: { error: "test_no_real_payout" } }); });
 await page.route("**/api/admin/wallet/config", route => route.fulfill({ json: { account: { id: accountId, label: "Wallet de prueba", mode: "production", publicKey: "local-public", hasPrivateKey: true, createdAt: "2026-11-10T15:00:00Z" }, billingConfigured: true } }));
 await page.route("**/api/" + surface + "/wallet/incoming?*", route => { incomingCalls++; return route.fulfill({ json: { ...context, status: "permission_required", reportMode: "production", periodStart: "2026-11-03T05:00:00Z", periodEnd: "2026-11-10T15:00:00Z", reportThrough: "2026-11-09", queriedAt: "2026-11-10T15:00:00Z", localCharges: [], localTruncated: false, reportComplete: false, unmatchedReportCount: 0 } }); });
 await page.route("**/api/" + surface + "/wallet/tracking**", async route => {
   const req = route.request(), url = new URL(req.url()); const body = req.method() === "POST" ? req.postDataJSON() : Object.fromEntries(url.searchParams);
   expect(body[surface === "admin" ? "accountId" : "restaurantId"]).toBe(surface === "admin" ? accountId : restaurantId);
   if (trackingFail) return route.fulfill({ status: 503, json: { error: "tracking_unavailable" } });
   if (url.pathname.endsWith("/history") && req.method() === "GET") return route.fulfill({ json: { ...context, trackingId: view.trackingId, candidates: [{ source: surface === "admin" ? "subscription" : "order", sourceId: "earlier-charge", occurredAt: "2026-11-09T15:00:00Z", dateBasis: "payment", amountCents: 1_000_000, refundedCents: 990_000, maxOpeningPendingCents: 1_000_000, currency: "COP", eligible: view.totals.incorporatedHistoryCents === 0, reason: view.totals.incorporatedHistoryCents ? "already_incorporated" : "account_not_verified", incorporatedCents: view.totals.incorporatedHistoryCents || null }], nextCursor: null } });
   if (req.method() === "POST" && !body.action) {
     submissions.push(body);
     if (rejectHistoricalOnce) { rejectHistoricalOnce = false; view = { ...view, historicalChangeToken: "c".repeat(64) }; return route.fulfill({ status: 409, json: { error: "tracking_history_changed" } }); }
     if (!applied.has(body.idempotencyKey)) {
       applied.add(body.idempotencyKey);
       if (url.pathname.endsWith("/adjustments")) view = { ...view, estimatedPendingCents: view.estimatedPendingCents! - body.amountCents, totals: { ...view.totals, registeredFeesCents: view.totals.registeredFeesCents + body.amountCents } };
       else view = { ...view, estimatedPendingCents: view.estimatedPendingCents! + body.remainingCents, totals: { ...view.totals, incorporatedHistoryCents: body.remainingCents } };
     }
     if (body.acknowledgeHistoricalChanges) view = { ...view, status: "active", reasons: [], historicalChangeToken: null };
     if (loseNext) { loseNext = false; return route.abort("failed"); }
   }
   await route.fulfill({ json: { ...view, ...context, ...(wrongScope ? { [surface === "admin" ? "accountId" : "restaurantId"]: "another-scope" } : {}), ...(url.searchParams.has("operationId") ? { operationFound: applied.has(url.searchParams.get("operationId")!) } : {}) } });
 });
 return { rejectHistoricalOnce: () => { rejectHistoricalOnce = true; }, restaurantId, goto: () => page.goto("/" + surface + "/wallet"), setView: (v: TrackingView) => { view = v; }, failBalance: () => { balanceFail = true; }, failTracking: () => { trackingFail = true; }, wrongScope: () => { wrongScope = true; }, loseNext: () => { loseNext = true; }, submissions, applied, incomingCalls: () => incomingCalls, payoutCalls: () => payoutCalls };
}
test.afterEach(async () => { if(users.size) await db.user.deleteMany({where:{id:{in:[...users]}}}); if(restaurants.size) await db.restaurant.deleteMany({where:{id:{in:[...restaurants]}}}); users.clear(); restaurants.clear(); });
test.afterAll(() => db.$disconnect());
for (const surface of ["admin", "operator"] as const) {
 test(surface + ": starts prospectively, keeps estimate independent from available and marks discrepancies", async ({ page }, info) => {
   const h = await fixture(page, surface); await h.goto();
   const summary = page.getByRole("region", { name: "Pendiente estimado por ingresar", exact: true });
   const panel = page.getByRole("region", { name: "Seguimiento de cobros", exact: true });
   await expect(summary).toContainText("2.500,30"); await expect(summary).toContainText("No incluye cobros anteriores");
   expect(h.incomingCalls()).toBe(0);
   await page.evaluate(async () => { window.scrollTo({ top:0, behavior:"instant" }); for(const id of ["admin-content","operator-content"])document.getElementById(id)?.scrollTo({top:0,behavior:"instant"}); await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))); });
   await page.screenshot({path:info.outputPath(surface+"-tracking-active.png"),fullPage:true,animations:"disabled"});
   if(surface === "admin") await expect(page.getByRole("button", {name:"Revisar transferencia", exact:true})).toBeDisabled(); else await expect(page.getByRole("button", {name:"Transferir a otra cuenta", exact:true})).toBeDisabled();
   h.failBalance(); await page.getByRole("button", {name:"Actualizar saldo", exact:true}).click(); await expect(page.getByText("Saldo no disponible", {exact:true}).first()).toBeVisible(); await expect(summary).toContainText("2.500,30");
   h.setView({...freshView(), status:"needs_review", estimatedPendingCents:null, signedDifferenceCents:-530, reasons:["negative_difference"]});
   await panel.getByRole("button", {name:"Actualizar seguimiento", exact:true}).click(); await expect(summary).toContainText("Diferencia por revisar"); await expect(summary).not.toContainText(/\$\s*0/); await expect(panel).toContainText(/-\$\s*5,30/);
   h.failTracking(); await panel.getByRole("button", {name:"Actualizar seguimiento",exact:true}).click(); await expect(panel.getByRole("alert")).toContainText("No pudimos actualizar"); await expect(summary).toContainText("Última estimación guardada");
   expect(h.payoutCalls()).toBe(0); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await panel.scrollIntoViewIfNeeded(); await page.screenshot({path:info.outputPath(surface+"-tracking.png"),animations:"disabled"});
 });
 test(surface + ": adjustment is confirmed and a lost response recovers after reload without duplicate writes", async ({page}) => {
   const h=await fixture(page,surface); await h.goto(); const panel=page.getByRole("region",{name:"Seguimiento de cobros",exact:true});
   await panel.getByRole("button",{name:"Registrar ajuste",exact:true}).click(); const dialog=page.getByRole("dialog",{name:"Ajuste del seguimiento",exact:true});
   await dialog.getByRole("textbox",{name:"Importe del ajuste",exact:true}).fill("100,30"); await dialog.getByRole("textbox",{name:"Motivo",exact:true}).fill("Comisión interna de prueba");
   await dialog.getByRole("button",{name:"Revisar registro",exact:true}).click(); expect(h.submissions).toHaveLength(0); h.loseNext();
   await dialog.getByRole("button",{name:"Confirmar registro",exact:true}).click(); await expect(dialog.getByRole("alert")).toContainText("Se perdió la respuesta");
   expect(h.submissions).toHaveLength(1); expect(h.applied.size).toBe(1); const key=h.submissions[0].idempotencyKey;
   const storage=await page.evaluate(()=>JSON.stringify(sessionStorage)); expect(storage).toContain(String(key)); expect(storage).not.toContain("Comisión interna de prueba");
   await page.reload(); await expect(panel).toContainText("100,30"); await expect(panel.getByText("Hay un ajuste o importe anterior pendiente de confirmar.",{exact:false})).toHaveCount(0); expect(h.submissions).toHaveLength(1); expect(h.applied.size).toBe(1);
 });
 test(surface + ": earlier charges require an explicit opening amount, cutoff date and reason",async({page})=>{
   const h=await fixture(page,surface);await h.goto();const panel=page.getByRole("region",{name:"Seguimiento de cobros",exact:true});
   await panel.getByRole("button",{name:"Revisar cobros anteriores",exact:true}).click();await panel.getByRole("button",{name:"Revisar importe pendiente",exact:true}).click();
   const dialog=page.getByRole("dialog",{name:"Incorporar pendiente anterior",exact:true});await expect(dialog).toContainText("Fecha de inicio del seguimiento");await expect(dialog).toContainText("10/11/2026");await expect(dialog).toContainText("Los abonos posteriores ya se reflejan");await expect(dialog).toContainText("Máximo al iniciar");await expect(dialog).toContainText("10.000,00");await expect(dialog.getByRole("textbox",{name:"Importe pendiente al iniciar seguimiento",exact:true})).toHaveValue("");
   await dialog.getByRole("textbox",{name:"Importe pendiente al iniciar seguimiento",exact:true}).fill("0");await dialog.getByRole("textbox",{name:"Motivo",exact:true}).fill("Importe anterior revisado");await dialog.getByRole("button",{name:"Revisar registro",exact:true}).click();await expect(dialog.getByRole("alert")).toBeVisible();expect(h.submissions).toHaveLength(0);
   await dialog.getByRole("textbox",{name:"Importe pendiente al iniciar seguimiento",exact:true}).fill("250,50");await dialog.getByRole("textbox",{name:"Motivo",exact:true}).fill("Importe anterior revisado");await dialog.getByRole("button",{name:"Revisar registro",exact:true}).click();expect(h.submissions).toHaveLength(0);await expect(dialog).toContainText("Fecha de inicio del seguimiento");await expect(dialog).toContainText("10/11/2026");await expect(dialog).toContainText("Este importe se incorpora al pendiente inicial");
   await dialog.getByRole("button",{name:"Confirmar registro",exact:true}).click();await expect(dialog).toHaveCount(0);expect(h.submissions[0].remainingCents).toBe(25050);expect(h.submissions[0].sourceId).toBe("earlier-charge");await expect(panel).toContainText("Ya incorporado");
 });
 test(surface+": another scope cannot supply the estimate",async({page})=>{const h=await fixture(page,surface);h.wrongScope();await h.goto();const panel=page.getByRole("region",{name:"Seguimiento de cobros",exact:true});await expect(panel.getByRole("alert")).toContainText("La cuenta cambió");await expect(page.getByRole("region",{name:"Pendiente estimado por ingresar",exact:true})).not.toContainText("2.500,30");});
}

async function merchantTransferFixture(page:Page) {
 const h=await fixture(page,"operator");
 await page.route("**/api/operator/wallet/balance",route=>route.fulfill({json:{availableCents:10_000_000,currency:"MXN"}}));
 const attempts:Record<string,unknown>[]=[];let outcome="preflight";let stored:Record<string,unknown>|null=null;let checks=0;
 await page.route("**/api/operator/wallet/disperse*",async route=>{
  if(route.request().method()==="GET"){checks++;expect(new URL(route.request().url()).searchParams.get("restaurantId")).toBe(h.restaurantId);return route.fulfill({json:{payout:stored}});}
  const body=route.request().postDataJSON();attempts.push(body);expect(body.restaurantId).toBe(h.restaurantId);expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  if(outcome==="preflight")return route.fulfill({status:503,json:{error:"credentials_missing"}});
  if(outcome==="missing")return route.abort("failed");
  stored={ok:true,payoutId:"payout-fixture",idempotencyKey:body.idempotencyKey,amountCents:body.amountCents,currency:"MXN",status:outcome==="lost"?"unknown":"initialized",providerRef:null,responseText:outcome==="lost"?"payout_unknown":null};
  if(outcome==="lost")return route.abort("failed");
  return route.fulfill({json:stored});
 });
 return {...h,attempts,checks:()=>checks,setOutcome:(value:string)=>{outcome=value;},approve:()=>{stored={...stored!,status:"approved",responseText:null};}};
}
async function prepareTransfer(page:Page,own:boolean){
 await page.getByRole("button",{name:own?"Pasar al banco":"Transferir a otra cuenta",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:own?"Pasar al banco":"Transferir a otra cuenta",exact:true});
 if(!own){await dialog.getByRole("combobox",{name:"Banco destino",exact:true}).selectOption("1007");await dialog.getByRole("textbox",{name:"Número de cuenta",exact:true}).fill("9876543210");await dialog.getByRole("textbox",{name:"Número de documento",exact:true}).fill("901000001");await dialog.getByRole("textbox",{name:"Nombre del titular",exact:true}).fill("Tercero de prueba");}
 await dialog.getByRole("textbox",{name:"Monto",exact:true}).fill("500,25");await dialog.getByRole("button",{name:"Revisar transferencia",exact:true}).click();await expect(dialog).toContainText("500,25 MXN");return dialog;
}
test("merchant: definite preflight allows editing and reuses the same attempt",async({page})=>{
 const h=await merchantTransferFixture(page);await h.goto();const dialog=await prepareTransfer(page,true);expect(h.attempts).toHaveLength(0);
 await dialog.getByRole("button",{name:"Confirmar transferencia",exact:true}).click();await expect(dialog).toContainText("no está configurada");expect(h.attempts).toHaveLength(1);expect(h.attempts[0].ownDestinationFingerprint).toMatch(/^[a-f0-9]{64}$/);
 await dialog.getByRole("button",{name:"Editar datos",exact:true}).click();await dialog.getByRole("textbox",{name:"Monto",exact:true}).fill("400,50");await dialog.getByRole("button",{name:"Revisar transferencia",exact:true}).click();h.setOutcome("initialized");await dialog.getByRole("button",{name:"Confirmar transferencia",exact:true}).click();await expect(dialog).toContainText("En proceso");expect(h.attempts).toHaveLength(2);expect(h.attempts[1].idempotencyKey).toBe(h.attempts[0].idempotencyKey);expect(h.attempts[1].amountCents).toBe(40050);
});
test("merchant: unknown transfer is recovered after reload without another payment",async({page},info)=>{
 const h=await merchantTransferFixture(page);h.setOutcome("lost");await h.goto();const dialog=await prepareTransfer(page,false);await dialog.getByRole("button",{name:"Confirmar transferencia",exact:true}).click();await expect(dialog).toContainText("Se perdió la respuesta");
 const storage=await page.evaluate(()=>JSON.stringify(sessionStorage));expect(storage).toContain(String(h.attempts[0].idempotencyKey));expect(storage).not.toContain("9876543210");expect(storage).not.toContain("Tercero de prueba");
 await dialog.getByRole("button",{name:"Cerrar",exact:true}).click();await page.reload();await expect(page.getByText("Por verificar",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Transferir a otra cuenta",exact:true})).toBeDisabled();expect(h.attempts).toHaveLength(1);expect(h.checks()).toBeGreaterThan(0);
 await page.getByText("Por verificar",{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath("merchant-transfer-unknown.png"),animations:"disabled"});
 h.approve();await page.getByRole("button",{name:"Consultar transferencia",exact:true}).click();await expect(page.getByText("Acreditada",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Transferir a otra cuenta",exact:true})).toBeEnabled();expect(h.attempts).toHaveLength(1);
});
test("merchant: a missing record after reload can only be reconstructed with the original UUID",async({page})=>{
 const h=await merchantTransferFixture(page);h.setOutcome("missing");await h.goto();let dialog=await prepareTransfer(page,false);await dialog.getByRole("button",{name:"Confirmar transferencia",exact:true}).click();await expect(dialog).toContainText("Se perdió la respuesta");const key=h.attempts[0].idempotencyKey;
 await dialog.getByRole("button",{name:"Cerrar",exact:true}).click();await page.reload();await expect(page.getByText("Aún no encontramos un registro de este envío.",{exact:false})).toBeVisible();await expect(page.getByRole("button",{name:"Transferir a otra cuenta",exact:true})).toBeEnabled();expect(h.attempts).toHaveLength(1);
 dialog=await prepareTransfer(page,false);h.setOutcome("initialized");await dialog.getByRole("button",{name:"Confirmar transferencia",exact:true}).click();await expect(dialog).toContainText("En proceso");expect(h.attempts).toHaveLength(2);expect(h.attempts[1].idempotencyKey).toBe(key);expect(h.attempts[1]).toEqual(h.attempts[0]);
});

const historicalConsentLabel = "Revisé los cambios de cobros anteriores y este ajuste contempla su efecto.";
test("admin: historic changes are never acknowledged implicitly by an adjustment", async ({page})=>{
 const h=await fixture(page,"admin");h.setView({...freshView(),status:"needs_review",reasons:["historical_sources_changed"],historicalChangeToken:"a".repeat(64)});await h.goto();
 const panel=page.getByRole("region",{name:"Seguimiento de cobros",exact:true});await panel.getByRole("button",{name:"Registrar ajuste",exact:true}).click();const dialog=page.getByRole("dialog",{name:"Ajuste del seguimiento",exact:true});
 await expect(dialog.getByRole("checkbox",{name:historicalConsentLabel,exact:true})).not.toBeChecked();await dialog.getByRole("textbox",{name:"Importe del ajuste",exact:true}).fill("50");await dialog.getByRole("textbox",{name:"Motivo",exact:true}).fill("Comisión registrada por separado");await dialog.getByRole("button",{name:"Revisar registro",exact:true}).click();await expect(dialog).toContainText("Los cambios anteriores seguirán pendientes de revisión.");
 await dialog.getByRole("button",{name:"Confirmar registro",exact:true}).click();await expect(dialog).toHaveCount(0);expect(h.submissions[0].acknowledgeHistoricalChanges).not.toBe(true);expect(h.submissions[0].historicalChangeToken).toBeUndefined();
 await expect(page.getByRole("region",{name:"Pendiente estimado por ingresar",exact:true})).not.toContainText("2.000,30");
});
test("operator: an explicit historic acknowledgement is shown and preserved on exact retry",async({page},info)=>{
 const h=await fixture(page,"operator");h.setView({...freshView(),status:"needs_review",reasons:["historical_sources_changed"],historicalChangeToken:"b".repeat(64)});await h.goto();const panel=page.getByRole("region",{name:"Seguimiento de cobros",exact:true});await panel.getByRole("button",{name:"Registrar ajuste",exact:true}).click();const dialog=page.getByRole("dialog",{name:"Ajuste del seguimiento",exact:true});
 await dialog.getByRole("combobox",{name:"Tipo de ajuste",exact:true}).selectOption("correction");await dialog.getByRole("textbox",{name:"Importe del ajuste",exact:true}).fill("0");await dialog.getByRole("textbox",{name:"Motivo",exact:true}).fill("Cambios previos revisados sin efecto adicional");await dialog.getByRole("checkbox",{name:historicalConsentLabel,exact:true}).check();await dialog.getByRole("button",{name:"Revisar registro",exact:true}).click();await expect(dialog).toContainText("Confirmas la revisión de los cambios anteriores observados.");expect(h.submissions).toHaveLength(0);
 await dialog.evaluate(async element => { element.scrollTo({ top: 0, behavior: "instant" }); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });await page.screenshot({path:info.outputPath("historical-changes-confirmation.png"),animations:"disabled"});h.loseNext();await dialog.getByRole("button",{name:"Confirmar registro",exact:true}).click();await expect(dialog.getByRole("alert")).toContainText("Se perdió la respuesta");await dialog.getByRole("button",{name:"Reintentar esta misma operación",exact:true}).click();await expect(dialog).toHaveCount(0);
 expect(h.submissions).toHaveLength(2);expect(h.submissions[0]).toEqual(h.submissions[1]);expect(h.submissions[0]).toMatchObject({acknowledgeHistoricalChanges:true,historicalChangeToken:"b".repeat(64),amountCents:0});expect(h.applied.size).toBe(1);
});
test("admin: an absent operation from a replaced tracking context is released without replay",async({page})=>{
 const h=await fixture(page,"admin");await h.goto();await expect(page.getByRole("region",{name:"Seguimiento de cobros",exact:true})).toContainText("Estimación actualizada");
 await page.evaluate(key=>sessionStorage.setItem("mesapay:wallet-tracking:admin:wallet-a",JSON.stringify({key,trackingId:"tracking-before-rotation",path:"/adjustments"})),randomUUID());await page.reload();
 const panel=page.getByRole("region",{name:"Seguimiento de cobros",exact:true});await expect(panel.getByRole("alert")).toContainText("El intento anterior ya no puede aplicarse");await expect(panel.getByRole("button",{name:"Registrar ajuste",exact:true})).toBeEnabled();expect(h.submissions).toHaveLength(0);expect(await page.evaluate(()=>sessionStorage.getItem("mesapay:wallet-tracking:admin:wallet-a"))).toBeNull();
});

test("admin: a changed historical token can be reviewed again under the same attempt",async({page})=>{
 const h=await fixture(page,"admin");h.setView({...freshView(),status:"needs_review",reasons:["historical_sources_changed"],historicalChangeToken:"a".repeat(64)});await h.goto();const panel=page.getByRole("region",{name:"Seguimiento de cobros",exact:true});await panel.getByRole("button",{name:"Registrar ajuste",exact:true}).click();const dialog=page.getByRole("dialog",{name:"Ajuste del seguimiento",exact:true});
 await dialog.getByRole("textbox",{name:"Importe del ajuste",exact:true}).fill("50");await dialog.getByRole("textbox",{name:"Motivo",exact:true}).fill("Cambios anteriores revisados");await dialog.getByRole("checkbox",{name:historicalConsentLabel,exact:true}).check();await dialog.getByRole("button",{name:"Revisar registro",exact:true}).click();h.rejectHistoricalOnce();await dialog.getByRole("button",{name:"Confirmar registro",exact:true}).click();await expect(dialog.getByRole("alert")).toContainText("variaron desde que los revisaste");
 const refreshed=page.waitForResponse(response=>response.url().endsWith("/api/admin/wallet/tracking")&&response.request().method()==="POST");await dialog.getByRole("button",{name:"Editar datos",exact:true}).click();await refreshed;await expect(dialog.getByRole("checkbox",{name:historicalConsentLabel,exact:true})).not.toBeChecked();await dialog.getByRole("checkbox",{name:historicalConsentLabel,exact:true}).check();await dialog.getByRole("button",{name:"Revisar registro",exact:true}).click();await dialog.getByRole("button",{name:"Reintentar esta misma operación",exact:true}).click();await expect(dialog).toHaveCount(0);
 expect(h.submissions).toHaveLength(2);expect(h.submissions[0].idempotencyKey).toBe(h.submissions[1].idempotencyKey);expect(h.submissions[1].historicalChangeToken).toBe("c".repeat(64));expect(h.applied.size).toBe(1);
});
