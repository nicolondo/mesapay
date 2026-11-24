import { getTranslations } from "next-intl/server";
import { staffSignOut } from "./signOutActions";

/**
 * Clase compartida por las acciones de la cabecera del personal: el enlace de
 * «Ayuda» del mesero y el botón de «Salir» de mesero/cocina/bar.
 *
 * `inline-flex items-center` + `min-h-11` deja 44px de alto para el dedo con el
 * texto centrado dentro de esa caja, y `-my-2` descuenta 8px arriba y abajo
 * para que en el flujo siga ocupando 28px — lo mismo que el título — y la
 * cabecera no crezca. El área táctil se come el padding de la cabecera sin
 * desbordarla.
 *
 * Que la usen los dos es la mitad del arreglo de alineación: ver el comentario
 * de `StaffSignOutButton`.
 */
export const staffHeaderActionClass =
  "inline-flex min-h-11 -my-2 items-center text-xs text-op-muted hover:text-ink";

/**
 * Botón de «Salir» de las cabeceras del personal (mesero, cocina, bar y
 * datáfono).
 *
 * Las cabeceras lo invocan como función (`{await StaffSignOutButton()}`) y no
 * como `<StaffSignOutButton />`, igual que ya hacen con su propio contenido:
 * así el árbol que devuelve el layout queda resuelto y se puede pintar en
 * síncrono (lo hace `staffNavigationPrefetch.test.ts` con `MeseroLayout`).
 *
 * El `flex` del `<form>` es la otra mitad del arreglo: un `<form>` en bloque
 * arma su propia línea con el *strut* de la tipografía heredada (16px/24px),
 * y el `<button>` —inline-block— se alineaba a ESA línea base, quedando 1px
 * más abajo que el `<a>` de «Ayuda» de al lado, que no va dentro de ningún
 * form. Con el form en flex su alto es el del botón y ambos los centra el
 * mismo `items-center` de la cabecera.
 */
export async function StaffSignOutButton({
  action = staffSignOut,
  className = staffHeaderActionClass,
}: {
  /** Server Function de cierre de sesión; ver `signOutActions.ts`. */
  action?: () => Promise<void>;
  className?: string;
} = {}) {
  const t = await getTranslations("operator");
  return (
    <form className="flex items-center" action={action}>
      <button type="submit" className={className}>
        {t("signOut")}
      </button>
    </form>
  );
}
