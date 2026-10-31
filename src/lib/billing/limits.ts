/**
 * Tope de cordura para montos de la membresía de MESAPAY (mensualidad del
 * comercio, pagos registrados a mano y precio de catálogo de los planes), en
 * centavos: $10.000.000 COP. Sólo frena errores de tipeo (un cero de más); no es
 * una regla comercial. Antes era $1.000.000 y bloqueaba planes reales (Pro a
 * $1.500.000). Cabe holgado en las columnas Int (INT4) de Postgres.
 */
export const MEMBERSHIP_MAX_CENTS = 1_000_000_000;
