// Turbopack (el bundler de `next dev`/`next build`) acepta plugins como texto
// o como función. El nuestro va como función importada: un texto con ruta
// relativa no lo encuentra, porque evalúa este archivo empaquetado en .next.
import legacyFallbacks from "./src/lib/css/postcssLegacyFallbacks.cjs";

const config = {
  plugins: [
    "@tailwindcss/postcss",
    // Respaldos para el piso de soporte (Chrome/WebView 99, Safari iOS 15.4:
    // datáfonos y celulares viejos). Va DESPUÉS de Tailwind porque corrige su
    // salida. Ver src/lib/css/postcssLegacyFallbacks.cjs.
    legacyFallbacks,
  ],
};

export default config;
