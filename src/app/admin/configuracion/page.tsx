import { getKushkiMode } from "@/lib/platformConfig";
import { KushkiModeSwitcher } from "../KushkiModeSwitcher";

export const dynamic = "force-dynamic";

/**
 * Configuración global de plataforma. Por ahora sólo el switch de
 * modo Kushki, pero pensada para crecer (toggles plataforma-wide,
 * feature flags, secrets globales, etc.).
 */
export default async function AdminConfiguracionPage() {
  const kushkiMode = await getKushkiMode();

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">Configuración</div>
      <p className="text-sm text-op-muted mb-6">
        Ajustes plataforma-wide. Los cambios afectan a todos los comercios
        en MESAPAY y se propagan a los procesos del cluster en ~60s.
      </p>

      <section className="mb-6">
        <KushkiModeSwitcher initialMode={kushkiMode} />
      </section>
    </div>
  );
}
