/**
 * Enlace al DETALLE de un renglón de un estado financiero, con el MISMO
 * universo del estado (acumulado hasta el corte en el ESFA; el rango en el
 * estado de resultado): quien abra el detalle ve exactamente los
 * movimientos que forman la cifra.
 *
 * Una cuenta POSTABLE va al libro mayor (`?cuenta=`), que filtra por
 * código exacto. Un PREFIJO (grupo, cuenta de 4 dígitos, o los códigos de
 * la cascada como `41`, `4210`, `54`) no tiene mayor propio: va al balance
 * de prueba filtrado por ese prefijo (`cta1 = cta2 = código`, hasta
 * subcuenta), que es el equivalente en MESAPAY del auxiliar por rango de
 * zenith. Los códigos no numéricos (`x05` de las naturalezas) no enlazan.
 */
export function drilldownHref({
  code,
  postable,
  desde,
  hasta,
}: {
  code: string;
  postable: boolean;
  desde: string;
  hasta: string;
}): string | undefined {
  if (!/^\d{1,10}$/.test(code)) return undefined;
  const sp = new URLSearchParams({ desde, hasta });
  if (postable) {
    sp.set("cuenta", code);
    return `/operator/reportes/libro-mayor?${sp.toString()}`;
  }
  sp.set("cta1", code);
  sp.set("cta2", code);
  sp.set("nivel", "6");
  return `/operator/reportes/balance-prueba?${sp.toString()}`;
}
