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
  "src/app/t/\\[slug\\]/menu/page.tsx",
  "src/app/t/\\[slug\\]/menu/MenuClient.tsx",
  "src/app/t/\\[slug\\]/page.tsx",
  "src/app/t/\\[slug\\]/order/\\[orderId\\]/*.{ts,tsx}",
  "src/app/t/\\[slug\\]/pay/\\[orderId\\]/PayClient.tsx",
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
