/**
 * Ruta VIEJA del impuesto de ventas. El editor se mudó a Configuración →
 * Impuestos y el endpoint con él (/api/operator/settings/impuestos): el
 * impuesto es un dato fiscal del comercio, no una función del módulo de
 * contabilidad, y acá vivía detrás de ese módulo.
 *
 * Se deja respondiendo EXACTAMENTE igual que la ruta nueva (mismos
 * handlers) para no romper a nadie a mitad de un deploy azul/verde. No le
 * agregues lógica propia: todo va en la ruta nueva.
 */
import {
  GET as impuestosGET,
  PATCH as impuestosPATCH,
} from "@/app/api/operator/settings/impuestos/route";

export const dynamic = "force-dynamic";

export const GET = impuestosGET;

export const PATCH = impuestosPATCH;
