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
  "src/app/operator/settings/page.tsx",
  "src/app/operator/settings/salon/**/*.{ts,tsx}",
  "src/app/operator/settings/estaciones/**/*.{ts,tsx}",
  "src/app/operator/settings/reservas/**/*.{ts,tsx}",
  "src/app/operator/settings/etiquetas/**/*.{ts,tsx}",
  "src/app/operator/settings/meseros/**/*.{ts,tsx}",
  "src/app/operator/settings/mesas/**/*.{ts,tsx}",
  "src/app/operator/settings/datafonos/**/*.{ts,tsx}",
  "src/app/operator/settings/staff-policies/**/*.{ts,tsx}",
  "src/app/operator/settings/usuarios/**/*.{ts,tsx}",
  "src/app/operator/settings/identidad/**/*.{ts,tsx}",
  "src/app/operator/settings/pagos/**/*.{ts,tsx}",
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
  ]),
]);

export default eslintConfig;
