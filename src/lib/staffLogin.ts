import type { Role } from "@prisma/client";

/**
 * ¿Este `User` puede iniciar sesión por /signin (NextAuth)?
 *
 * Vive fuera de `src/auth.ts` por una razón concreta: la regla "el login del
 * personal no se rompe" es la restricción dura de la separación
 * comensal-por-comercio, y una función pura se puede probar sin levantar
 * NextAuth ni la base de datos. `src/auth.ts` la llama y no duplica la
 * lógica; el test de `staffLogin.test.ts` es el que garantiza que operator,
 * mesero, kitchen, bar, terminal, platform_admin y group_admin siguen
 * entrando exactamente como antes.
 */
export function canStaffSignIn(user: {
  role: Role;
  disabledAt: Date | null;
}): boolean {
  // Comercial desactivado (o cualquier usuario apagado desde admin).
  if (user.disabledAt != null) return false;
  // `User` es SOLO personal desde que el comensal vive en `Diner`. En
  // producción quedan filas viejas con role=customer — el valor del enum no
  // se puede borrar mientras haya filas usándolo — y no deben poder entrar
  // por la puerta del personal.
  if (user.role === "customer") return false;
  return true;
}
