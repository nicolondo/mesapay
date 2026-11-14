/**
 * ¿El POST de una ruta de impresión viene de «Este dispositivo»? Lo manda
 * `printAsStaff` con el cuerpo `{ "destination": "device" }` (ver
 * `staffPrint.ts`): la ruta no encola nada en el agente, sólo valida y deja
 * el rastro. Sin cuerpo (los botones de siempre) o con uno que no se
 * entiende, es la impresora de caja: lo de siempre.
 */
export async function wantsDevicePrint(req: Request): Promise<boolean> {
  try {
    const text = await req.text();
    if (!text) return false;
    const body = JSON.parse(text) as unknown;
    return (
      !!body &&
      typeof body === "object" &&
      (body as Record<string, unknown>).destination === "device"
    );
  } catch {
    return false;
  }
}
