import type { Role } from "@prisma/client";
import { ownerWhere, type TenantModel } from "@/lib/backups/tables";

/**
 * Qué pasa con cada tabla cuando se ELIMINA un comercio.
 *
 * Los modelos "del comercio" salen solos del DMMF, con la misma regla que
 * las copias de seguridad (`tenantModels()` de src/lib/backups/tables.ts):
 * todo modelo con `restaurantId` y sus hijos por relación obligatoria. Esos
 * se borran en orden hijos→padres (`topologicalOrder().delete`) y van
 * completos al archivo final.
 *
 * Todo lo demás está clasificado A MANO en una de dos listas, cada entrada
 * con su porqué: PLATFORM_MODEL_POLICY (tablas que las copias excluyen pero
 * que sí tienen que ver con el comercio) y UNRELATED_MODELS (tablas que no
 * guardan datos de ningún comercio). El test `policy.test.ts` exige que TODO
 * modelo del esquema esté en exactamente una de las tres: una tabla nueva
 * rompe la CI hasta que alguien decida qué hacer con ella al borrar.
 */
export type PlatformModelPolicy =
  /** Las filas del comercio se borran; `archive` = van antes al archivo final. */
  | { action: "delete"; archive: boolean; reason: string }
  /**
   * Las filas se CONSERVAN: son registro de la plataforma. La FK al comercio
   * es `SetNull` (lo verifica el test), así que al borrar el comercio quedan
   * sin vínculo. Igual van copiadas al archivo final.
   */
  | { action: "detach"; archive: true; reason: string }
  /** Se van en cascada con su dueño (un User o un Diner), nunca por comercio. */
  | { action: "with_owner"; owner: "User" | "Diner"; reason: string }
  /** Usuarios: regla propia por rol (ver users.ts). */
  | { action: "users"; archive: true; reason: string };

export const PLATFORM_MODEL_POLICY: Readonly<Record<string, PlatformModelPolicy>> = {
  User: {
    action: "users",
    archive: true,
    reason:
      "El personal del comercio se borra; los roles de plataforma (platform_admin, group_admin, comerciales) NUNCA: sólo se desvinculan. Ver users.ts.",
  },
  RestaurantBackup: {
    action: "delete",
    archive: false,
    reason:
      "Copias de 7 días del mismo comercio: son estados más viejos; el archivo final ya es la copia completa más reciente.",
  },
  PlatformEvent: {
    action: "delete",
    archive: false,
    reason: "Log de avisos SSE ('cambió una cuenta'): regenerable, sin valor de registro.",
  },
  PushSubscription: {
    action: "delete",
    archive: false,
    reason: "Suscripciones push atadas al comercio: credenciales del navegador, no datos del negocio.",
  },
  DinerSession: {
    action: "with_owner",
    owner: "Diner",
    reason: "Sesiones del comensal: se van en cascada con su Diner (que es del comercio).",
  },
  DinerMagicLink: {
    action: "with_owner",
    owner: "Diner",
    reason: "Enlaces de acceso del comensal: cascada con su Diner.",
  },
  PasswordResetToken: {
    action: "with_owner",
    owner: "User",
    reason: "Tokens de restablecimiento: cascada con el usuario borrado.",
  },
  MembershipPayment: {
    action: "detach",
    archive: true,
    reason: "Pago de la mensualidad a MESAPAY: ingreso de la plataforma. Queda con deletedRestaurantName.",
  },
  CommissionEntry: {
    action: "detach",
    archive: true,
    reason:
      "Comisión del comercial: obligación de la plataforma (pagada o pendiente). Queda con deletedRestaurantName.",
  },
  CrmLead: {
    action: "detach",
    archive: true,
    reason: "Pipeline comercial de la plataforma: el lead queda, sin comercio vinculado.",
  },
  AuditEvent: {
    action: "detach",
    archive: true,
    reason:
      "Bitácora append-only de la plataforma: no se borra (pierde el vínculo) y además va copiada al archivo final.",
  },
  KushkiWebhookEvent: {
    action: "detach",
    archive: true,
    reason: "Registro de idempotencia de webhooks: borrarlo permitiría reprocesar un evento ya aplicado.",
  },
  BillingSubscription: {
    action: "delete",
    archive: true,
    reason:
      "Débito automático: sólo se llega al borrado si está cancelado (si no, bloquea). No guarda el PAN, sólo marca y últimos 4.",
  },
  KushkiDocument: {
    action: "delete",
    archive: true,
    reason: "Documentos del alta con Kushki: la fila y el archivo van al archivo final; del disco se borran.",
  },
  DianConfig: {
    action: "delete",
    archive: true,
    reason: "Configuración DIAN del comercio: va al archivo final SIN el certificado, su clave ni el PIN.",
  },
  FinancialOperation: {
    action: "delete",
    archive: true,
    reason: "Idempotencia de cobros/reembolsos de los Payment del comercio. Sin FK: se ubica por paymentId.",
  },
};

/** Modelos que no guardan datos de ningún comercio: el borrado no los toca. */
export const UNRELATED_MODELS: Readonly<Record<string, string>> = {
  Group: "El grupo queda: el comercio sólo se desvincula (la FK está del lado del comercio).",
  LegalEntity:
    "Razón social del grupo: la numeración DIAN compartida sigue viva para los demás locales.",
  PlanConfig: "Catálogo de planes de la plataforma.",
  PlatformConfig: "Configuración global de la plataforma.",
  Translation: "Caché global de traducciones, por texto.",
  RateLimitBucket: "Contadores con vencimiento propio.",
  CreditNoteSeries:
    "Consecutivo de notas crédito por NIT y ambiente: los números ya usados quedan quemados, nunca se reinicia.",
  CreditNoteFileSeries: "Consecutivo de nombres de archivo DIAN por NIT: ídem.",
  CrmContact: "Cuelga de CrmLead, que se conserva.",
  CrmActivity: "CRM de ventas de la plataforma (cuelga del lead).",
  CrmAppointment: "CRM de ventas de la plataforma (cuelga del lead).",
  CrmDocument: "Material comercial de la plataforma.",
  CrmEmailTemplate: "Plantillas del CRM de la plataforma.",
  CrmWhatsappTemplate: "Plantillas del CRM de la plataforma.",
  CrmEmailAccount: "Cuenta de correo de un comercial (plataforma).",
  CrmCountry: "Catálogo de países del CRM.",
  CrmCity: "Catálogo de ciudades del CRM.",
  DeletedRestaurantArchive: "Es el propio archivo final de los comercios eliminados.",
};

/**
 * Roles del PERSONAL del comercio: se borran con él. `customer` es legado
 * (comensales viejos como User) y tampoco sobrevive al comercio.
 */
export const STAFF_ROLES: readonly Role[] = ["operator", "mesero", "kitchen", "bar", "terminal", "customer"];
/**
 * Roles de PLATAFORMA: nunca se borran con un comercio. Si alguno quedó con
 * `restaurantId` apuntando acá, sólo se desvincula (restaurantId → null).
 */
export const PLATFORM_ROLES: readonly Role[] = ["platform_admin", "group_admin", "comercial", "gerente_comercial"];

/** Tablas que se van en cascada con el usuario y no cuentan como "referencia ajena". */
export const USER_OWNED_MODELS: ReadonlySet<string> = new Set([
  "PasswordResetToken",
  "PushSubscription",
  "CrmEmailAccount",
]);

/**
 * Columnas que guardan una URL `/uploads/…` de un archivo SUBIDO por el
 * comercio. `archive` dice en qué carpeta del ZIP final se copia el archivo
 * antes de borrarlo del disco (false = no se conserva: fotos de la carta,
 * logo, fotos de marcación de asistencia).
 *
 * El test exige que toda columna `*Url` del esquema esté acá o en
 * FOREIGN_UPLOAD_COLUMNS.
 */
export const UPLOAD_COLUMNS: readonly { model: string; field: string; archive: false | "purchase-invoices" | "onboarding" }[] = [
  { model: "Restaurant", field: "logoUrl", archive: false },
  { model: "MenuItem", field: "photoUrl", archive: false },
  { model: "StaffShift", field: "checkInPhotoUrl", archive: false },
  { model: "StaffShift", field: "checkOutPhotoUrl", archive: false },
  // Facturas de compra: soporte contable del comercio → se conservan.
  { model: "PurchaseInvoiceUpload", field: "fileUrl", archive: "purchase-invoices" },
  // Documentos del alta (RUT, cámara de comercio, certificación bancaria…).
  { model: "KushkiDocument", field: "fileUrl", archive: "onboarding" },
];
/**
 * Columnas con archivos que NO son de ningún comercio. Sólo se consultan para
 * no borrar del disco un archivo que todavía use otra fila.
 */
export const FOREIGN_UPLOAD_COLUMNS: readonly { model: string; field: string }[] = [
  { model: "Group", field: "logoUrl" },
  { model: "CrmDocument", field: "fileUrl" },
];

/**
 * Secretos que NO van al archivo final: hashes de contraseñas y tokens, y
 * credenciales cifradas (llaves Kushki, certificado DIAN, PIN del software).
 * El comercio ya no existe: nada de esto le sirve a nadie, y un archivo que
 * se guarda años no puede ser una fuente de credenciales. Se reemplazan por
 * null y el manifest lista qué se quitó. El test exige que todo campo
 * `passwordHash`/`tokenHash`/`…Enc` de una tabla archivada esté acá.
 */
export const ARCHIVE_REDACTED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Restaurant: ["kushkiPrivateKeyEnc", "kushkiWebhookSecretEnc", "kushkiPayoutPrivateKeyEnc"],
  User: ["passwordHash"],
  Diner: ["passwordHash"],
  DianConfig: ["certP12Enc", "certPasswordEnc", "softwarePinEnc"],
  PrintAgent: ["tokenHash"],
  PaymentLink: ["token"],
};
export const SECRET_FIELD_PATTERN = /passwordHash|tokenHash|Enc$/;

/**
 * `where` de las filas de un modelo del comercio que se BORRAN. Más amplio
 * que `ownerWhere` (que es para leer la copia) en dos casos, para no dejar
 * nada colgando del comercio aunque un dato haya quedado inconsistente:
 *   - con `restaurantId` propio, sólo ese filtro (IngredientBarcode exige
 *     además que el insumo sea del comercio al leer);
 *   - SupplierInvoiceAlias: basta que el proveedor O el insumo sean del
 *     comercio (las dos FKs cascadean).
 */
export function tenantDeletionWhere(model: TenantModel, restaurantId: string): Record<string, unknown> {
  if (model.ownerPath.length === 0) return { restaurantId };
  if (model.name === "SupplierInvoiceAlias") {
    return { OR: [{ supplier: { restaurantId } }, { ingredient: { restaurantId } }] };
  }
  return ownerWhere(model, restaurantId);
}
