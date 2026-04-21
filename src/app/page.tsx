import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  const tenants = await db.restaurant.findMany({ orderBy: { name: "asc" } }).catch(() => []);
  const demoTenant = tenants[0];

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16 bg-bone text-ink">
      <div className="w-full max-w-xl">
        <div className="text-center">
          <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-muted mb-6">
            MESAPAY · QR ordering for restaurants
          </div>
          <h1 className="font-display text-5xl md:text-6xl leading-[1.05] tracking-[-0.02em]">
            Ordena y paga <em>desde tu mesa</em>.
          </h1>
          <p className="mt-5 text-ink-3 text-lg max-w-md mx-auto">
            Escanea el QR de tu mesa, explora la carta y paga sin esperar la cuenta.
            <span className="block mt-2 text-muted">
              No necesitas crear cuenta para ordenar.
            </span>
          </p>

          {demoTenant && (
            <div className="mt-10">
              <Link
                href={`/t/${demoTenant.slug}`}
                className="inline-flex h-12 px-6 rounded-xl bg-ink text-bone items-center justify-center font-medium"
              >
                Ver demo →
              </Link>
              <div className="mt-3 font-mono text-[10px] tracking-[0.16em] uppercase text-muted-2">
                Simula la experiencia del comensal
              </div>
            </div>
          )}
        </div>

        {tenants.length > 0 && (
          <div className="mt-16 text-left">
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-3">
              Restaurantes activos
            </div>
            <ul className="border-t border-hairline">
              {tenants.map((t) => (
                <li key={t.id} className="border-b border-hairline">
                  <Link
                    href={`/t/${t.slug}`}
                    className="flex items-center justify-between py-4 group"
                  >
                    <div>
                      <div className="font-display text-2xl">{t.name}</div>
                      {t.tagline && <div className="text-sm text-muted">{t.tagline}</div>}
                    </div>
                    <div className="font-mono text-xs text-muted group-hover:text-terracotta">
                      {t.slug} →
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-muted-2">
              En producción, cada restaurante vive en <code className="font-mono">{"<slug>"}.mesapay.co</code>.
              Localmente usamos el parámetro <code className="font-mono">?tenant=</code>.
            </p>
          </div>
        )}

        <div className="mt-16 pt-8 border-t border-hairline">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-3">
            ¿Tienes un restaurante, o eres operador?
          </div>
          <div className="flex gap-3">
            <Link
              href="/signin"
              className="h-11 px-5 rounded-xl border border-hairline inline-flex items-center justify-center font-medium text-ink text-sm"
            >
              Ingresar
            </Link>
            <Link
              href="/signup/restaurant"
              className="h-11 px-5 rounded-xl bg-ink text-bone inline-flex items-center justify-center font-medium text-sm"
            >
              Registrar mi restaurante
            </Link>
          </div>
          <p className="mt-3 text-xs text-muted-2">
            Las cuentas son para operadores (meseros, cocina, admin). Los clientes
            ordenan directamente desde el QR, sin registro.
          </p>
        </div>
      </div>
    </main>
  );
}
