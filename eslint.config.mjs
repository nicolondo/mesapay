import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import i18next from "eslint-plugin-i18next";

/**
 * GUARDARRAÍL i18n — el que evita la regresión.
 *
 * `i18next/no-literal-string` (modo jsx-text-only) ROMPE el lint si hay
 * texto literal dentro de JSX, p. ej. `<button>Pagar</button>`. La idea:
 * todo string a la vista debe pasar por `t("clave")` y vivir en
 * messages/{es,en,pt}.json.
 *
 * Está activo SÓLO en archivos ya migrados (lista MIGRATED). Los ~1.200
 * strings legacy todavía en español NO rompen el build. A medida que se
 * migra un archivo/carpeta, se agrega su glob acá y queda blindado para
 * que nadie reintroduzca español suelto. La meta de largo plazo es que
 * MIGRATED cubra `src/**` entero.
 */
const MIGRATED = [
  "src/i18n/**/*.{ts,tsx}",
  "src/components/LocaleSwitcher.tsx",
  "src/app/nicolas/**/*.{ts,tsx}",
  // OJO: los corchetes de las rutas dinámicas de Next ([slug]) son clases
  // de caracteres en glob — hay que escaparlos (\\[ \\]) o la regla no
  // aplica a esos archivos.
  "src/app/r/\\[slug\\]/page.tsx",
  "src/app/r/\\[slug\\]/ReservarClient.tsx",
  "src/app/r/\\[slug\\]/reserva/\\[code\\]/**/*.{ts,tsx}",
  "src/app/t/\\[slug\\]/menu/page.tsx",
  "src/app/t/\\[slug\\]/menu/MenuClient.tsx",
  "src/app/t/\\[slug\\]/page.tsx",
  "src/app/t/\\[slug\\]/order/\\[orderId\\]/*.{ts,tsx}",
  "src/app/t/\\[slug\\]/pay/\\[orderId\\]/PayClient.tsx",
  "src/app/t/\\[slug\\]/pay/\\[orderId\\]/ApplePayButton.tsx",
  "src/app/t/\\[slug\\]/pay/\\[orderId\\]/cash/*.{ts,tsx}",
  "src/app/t/\\[slug\\]/pay/\\[orderId\\]/terminal/*.{ts,tsx}",
  "src/app/t/\\[slug\\]/pay/\\[orderId\\]/3ds-return/*.{ts,tsx}",
  "src/app/t/\\[slug\\]/pay/\\[orderId\\]/pse-return/*.{ts,tsx}",
  "src/app/t/\\[slug\\]/pay/\\[orderId\\]/done/*.{ts,tsx}",
  "src/app/p/\\[slug\\]/page.tsx",
  "src/app/p/\\[slug\\]/\\[orderId\\]/status/*.{ts,tsx}",
  "src/app/factura/\\[id\\]/page.tsx",
  "src/app/factura/\\[id\\]/PrintButton.tsx",
  "src/app/operator/layout.tsx",
  "src/app/operator/OperatorMobileMenu.tsx",
  "src/app/operator/GroupSwitcher.tsx",
  "src/app/operator/page.tsx",
  "src/app/operator/ratings/**/*.{ts,tsx}",
  "src/app/operator/facturas/**/*.{ts,tsx}",
  "src/app/operator/wallet/**/*.{ts,tsx}",
  "src/app/operator/print/\\[station\\]/**/*.{ts,tsx}",
  "src/app/operator/kitchen/page.tsx",
  "src/app/operator/kitchen/KitchenBoard.tsx",
  "src/app/operator/bar/page.tsx",
  "src/app/operator/serve/page.tsx",
  "src/app/operator/serve/ServeBoard.tsx",
  "src/app/operator/payments/page.tsx",
  "src/app/operator/orders/page.tsx",
  "src/app/operator/orders/\\[id\\]/page.tsx",
  "src/app/operator/reservas/page.tsx",
  "src/app/operator/reservas/ReservasBoard.tsx",
  "src/app/operator/tables/**/*.{ts,tsx}",
  "src/app/operator/inventario/**/*.{ts,tsx}",
  "src/app/operator/compras/**/*.{ts,tsx}",
  "src/app/operator/recetas/**/*.{ts,tsx}",
  "src/app/operator/contabilidad/**/*.{ts,tsx}",
  "src/app/operator/produccion/**/*.{ts,tsx}",
  "src/app/operator/horarios/**/*.{ts,tsx}",
  "src/app/operator/settings/page.tsx",
  "src/app/operator/settings/salon/**/*.{ts,tsx}",
  "src/app/operator/settings/estaciones/**/*.{ts,tsx}",
  "src/app/operator/settings/reservas/**/*.{ts,tsx}",
  "src/app/operator/settings/etiquetas/**/*.{ts,tsx}",
  "src/app/operator/settings/insumos/**/*.{ts,tsx}",
  "src/app/operator/settings/proveedores/**/*.{ts,tsx}",
  "src/app/operator/settings/meseros/**/*.{ts,tsx}",
  "src/app/operator/settings/mesas/**/*.{ts,tsx}",
  "src/app/operator/settings/datafonos/**/*.{ts,tsx}",
  "src/app/operator/settings/staff-policies/**/*.{ts,tsx}",
  "src/app/operator/settings/usuarios/**/*.{ts,tsx}",
  "src/app/operator/settings/suscripcion/**/*.{ts,tsx}",
  "src/app/operator/settings/identidad/**/*.{ts,tsx}",
  "src/app/operator/settings/pagos/**/*.{ts,tsx}",
  "src/app/operator/menu/page.tsx",
  "src/app/operator/menu/MenuEditor.tsx",
  "src/app/operator/menu/import/**/*.{ts,tsx}",
  "src/app/operator/menus/**/*.{ts,tsx}",
  "src/app/operator/reports/**/*.{ts,tsx}",
  "src/app/operator/shifts/page.tsx",
  "src/app/operator/shifts/\\[id\\]/**/*.{ts,tsx}",
  "src/app/admin/layout.tsx",
  "src/app/admin/AdminMobileMenu.tsx",
  "src/app/admin/page.tsx",
  "src/app/admin/KushkiModeSwitcher.tsx",
  "src/app/admin/KushkiBillingKeysCard.tsx",
  "src/app/admin/configuracion/**/*.{ts,tsx}",
  "src/app/admin/CrmCountriesCard.tsx",
  "src/app/admin/audit/**/*.{ts,tsx}",
  "src/app/admin/restaurants/page.tsx",
  "src/app/admin/restaurants/new/**/*.{ts,tsx}",
  "src/app/admin/restaurants/\\[id\\]/page.tsx",
  "src/app/admin/restaurants/\\[id\\]/RestaurantNameEditor.tsx",
  "src/app/admin/restaurants/\\[id\\]/UsersPanel.tsx",
  "src/app/admin/restaurants/\\[id\\]/GroupAssignPanel.tsx",
  "src/app/admin/restaurants/\\[id\\]/PaymentMethodsPanel.tsx",
  "src/app/admin/restaurants/\\[id\\]/BillingPanel.tsx",
  "src/app/admin/restaurants/\\[id\\]/AdminAiConfig.tsx",
  "src/app/admin/restaurants/\\[id\\]/DangerZonePanel.tsx",
  "src/components/CashBox.tsx",
  "src/app/admin/restaurants/\\[id\\]/pagos/**/*.{ts,tsx}",
  "src/app/admin/plans/**/*.{ts,tsx}",
  "src/app/admin/groups/**/*.{ts,tsx}",
  "src/app/group/**/*.{ts,tsx}",
  "src/app/terminal/**/*.{ts,tsx}",
  "src/app/comercial/**/*.{ts,tsx}",
  "src/app/admin/comisiones/**/*.{ts,tsx}",
  "src/app/admin/restaurants/\\[id\\]/AdminSalesRep.tsx",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: MIGRATED,
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": [
        "error",
        {
          mode: "jsx-text-only",
          "should-validate-template": true,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Design handoff bundle (claude.ai/design prototype) — NOT imported by the
    // app, never shipped. Linting it floods `npm run lint` with ~150 false
    // positives (undefined mockup components, etc.) and drowns real signal.
    "reference/**",
    // Playwright crawler/specs are tooling, not app code.
    "e2e/**",
  ]),
]);

export default eslintConfig;
