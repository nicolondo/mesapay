import Link from "next/link";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { HeroPhone } from "@/components/landing/HeroPhone";
import { Reveal } from "@/components/landing/Reveal";
import { StatCountUp } from "@/components/landing/StatCountUp";

export const dynamic = "force-dynamic";

export default async function Landing() {
  const tenants = await db.restaurant
    .findMany({ orderBy: { name: "asc" }, take: 6 })
    .catch(() => []);
  const demoTenant = tenants[0];

  const qrTarget = demoTenant
    ? `https://mesapay.co/t/${demoTenant.slug}`
    : "https://mesapay.co";
  const qrSvg = await QRCode.toString(qrTarget, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
    color: { dark: "#1A1613", light: "#00000000" },
  }).catch(() => "");

  return (
    <div className="flex flex-1 flex-col bg-bone text-ink">
      <SiteHeader demoSlug={demoTenant?.slug ?? null} />
      <Hero demoSlug={demoTenant?.slug ?? null} qrSvg={qrSvg} />
      <Marquee />
      <HowItWorks />
      <Features />
      <Benefits />
      <FlowStrip />
      <Pricing />
      <LiveDemoStrip
        tenants={tenants.map((t) => ({ slug: t.slug, name: t.name }))}
      />
      <FinalCta />
      <SiteFooter />
    </div>
  );
}

/* ---------------- Header ---------------- */

function SiteHeader({ demoSlug }: { demoSlug: string | null }) {
  return (
    <header className="sticky top-0 z-30 backdrop-blur-xl bg-bone/80 border-b border-hairline/60">
      <div className="max-w-6xl mx-auto px-5 md:px-8 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-ink text-bone flex items-center justify-center text-[11px] font-mono">
            M
          </div>
          <span className="font-display text-xl tracking-[-0.01em]">
            MESAPAY
          </span>
          <span className="hidden md:inline font-mono text-[10px] tracking-[0.18em] uppercase text-muted ml-2">
            Restaurantes sin fila
          </span>
        </div>
        <nav className="hidden md:flex items-center gap-7 text-sm text-ink-3">
          <a href="#como-funciona" className="hover:text-ink">
            Cómo funciona
          </a>
          <a href="#beneficios" className="hover:text-ink">
            Beneficios
          </a>
          <a href="#planes" className="hover:text-ink">
            Planes
          </a>
        </nav>
        <div className="flex items-center gap-2">
          {demoSlug && (
            <Link
              href={`/t/${demoSlug}`}
              className="hidden md:inline-flex h-9 px-3 rounded-lg text-sm text-ink-3 hover:text-ink items-center"
            >
              Ver demo
            </Link>
          )}
          <Link
            href="/signin"
            className="hidden md:inline-flex h-9 px-3 rounded-lg text-sm text-ink hover:bg-hairline/40 items-center"
          >
            Ingresar
          </Link>
          <Link
            href="/signup/restaurant"
            className="h-9 px-4 rounded-lg bg-ink text-bone text-sm font-medium inline-flex items-center"
          >
            Registrar mi restaurante
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ---------------- Hero ---------------- */

function Hero({
  demoSlug,
  qrSvg,
}: {
  demoSlug: string | null;
  qrSvg: string;
}) {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 grain" aria-hidden />
      <div className="absolute inset-0 grid-bg opacity-[0.5]" aria-hidden />

      <div className="relative max-w-6xl mx-auto px-5 md:px-8 pt-14 md:pt-24 pb-16 md:pb-24 grid md:grid-cols-12 gap-10 items-center">
        <div className="md:col-span-7">
          <div className="inline-flex items-center gap-2 h-7 px-3 rounded-full border border-hairline bg-paper/70 backdrop-blur text-[11px] font-mono tracking-wider uppercase text-ink-3 fade-up">
            <span className="w-1.5 h-1.5 rounded-full bg-ok dot-blink" />
            En vivo en Medellín
          </div>
          <h1 className="mt-5 font-display text-[44px] leading-[1.02] md:text-[72px] md:leading-[1.02] tracking-[-0.025em] fade-up" style={{ animationDelay: "0.05s" }}>
            La cuenta por favor,{" "}
            <em className="italic shimmer-text">en su mesa</em>.
          </h1>
          <p className="mt-5 max-w-xl text-lg md:text-xl text-ink-3 fade-up" style={{ animationDelay: "0.15s" }}>
            Tus clientes piden y pagan desde su celular escaneando el QR de la
            mesa. Tú dejas de esperar a que alguien pida la cuenta, rotas mesas
            más rápido y ves cada orden, cada pago y cada propina en vivo hasta
            el cierre de turno.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3 fade-up" style={{ animationDelay: "0.25s" }}>
            <Link
              href="/signup/restaurant"
              className="h-12 px-6 rounded-xl bg-ink text-bone font-medium inline-flex items-center gap-2 hover:bg-ink-2 transition-colors"
            >
              Registrar mi restaurante
              <span aria-hidden>→</span>
            </Link>
            {demoSlug && (
              <Link
                href={`/t/${demoSlug}`}
                className="h-12 px-5 rounded-xl border border-hairline bg-paper/60 backdrop-blur text-ink font-medium inline-flex items-center gap-2"
              >
                Probar como cliente
              </Link>
            )}
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted fade-up" style={{ animationDelay: "0.35s" }}>
            <span className="inline-flex items-center gap-1.5">
              <Check /> Prueba de 14 días
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check /> Sin instalar nada en la mesa
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check /> Compatible con tu cocina actual
            </span>
          </div>
          <div className="mt-5 text-xs text-muted fade-up" style={{ animationDelay: "0.45s" }}>
            ¿Cliente?{" "}
            <Link href="/signup" className="text-terracotta underline">
              Crea tu cuenta
            </Link>{" "}
            para guardar tu historial y pagar más rápido.
          </div>
        </div>

        <div className="md:col-span-5 flex justify-center fade-up" style={{ animationDelay: "0.2s" }}>
          <HeroPhone qrSvg={qrSvg} />
        </div>
      </div>
    </section>
  );
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M2 6.5L5 9.5L10 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ---------------- Marquee ---------------- */

function Marquee() {
  const items = [
    "Mesas sin fila",
    "Cuentas divididas en segundos",
    "Cocina en vivo",
    "Salón sin caos",
    "Propinas hasta 22% mayores",
    "Cierre de turno automático",
    "Efectivo trazable",
    "Reseñas por plato",
  ];
  const doubled = [...items, ...items];
  return (
    <div className="relative border-y border-hairline bg-paper/50 overflow-hidden">
      <div className="absolute inset-y-0 left-0 w-20 bg-gradient-to-r from-bone to-transparent z-10 pointer-events-none" />
      <div className="absolute inset-y-0 right-0 w-20 bg-gradient-to-l from-bone to-transparent z-10 pointer-events-none" />
      <div className="marquee-track flex gap-10 whitespace-nowrap py-4 w-[200%]">
        {doubled.map((t, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-4 font-mono text-[11px] tracking-[0.18em] uppercase text-ink-3"
          >
            {t}
            <span className="inline-block w-1 h-1 rounded-full bg-terracotta/60" />
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- How it works ---------------- */

function HowItWorks() {
  const steps = [
    {
      kicker: "01 · Escanear",
      title: "El cliente escanea el QR de su mesa",
      copy: "Un QR por mesa, sin apps ni registros. MESAPAY abre la carta exacta de tu restaurante, con fotos, modificadores y disponibilidad en tiempo real.",
      badge: "Sin instalar nada",
    },
    {
      kicker: "02 · Ordenar",
      title: "Ordenan desde su celular y la cocina lo ve al instante",
      copy: "Cada plato viaja directo a cocina con modificadores, notas y el nombre del cliente. Sin errores de transcripción, sin mesero corriendo.",
      badge: "Cocina en vivo",
    },
    {
      kicker: "03 · Pagar",
      title: "Pagan solos, dividen la cuenta o llaman al mesero",
      copy: "Tarjeta, Apple Pay, Google Pay, Nequi, PSE, USDT o efectivo. Dividen por persona o en partes iguales. Si pagan en efectivo, el mesero recibe el cobro con el cambio ya calculado.",
      badge: "Cuenta dividida sin drama",
    },
  ];

  return (
    <section id="como-funciona" className="relative py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-5 md:px-8">
        <Reveal>
          <div className="max-w-2xl">
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-terracotta">
              Cómo funciona
            </div>
            <h2 className="mt-3 font-display text-4xl md:text-5xl leading-[1.05] tracking-[-0.015em]">
              Tres pasos. Cero espera.
            </h2>
            <p className="mt-4 text-ink-3 text-lg">
              El flujo completo desde que el cliente se sienta hasta que pagas a
              tu proveedor — en una sola herramienta.
            </p>
          </div>
        </Reveal>

        <div className="mt-12 grid md:grid-cols-3 gap-4 md:gap-6">
          {steps.map((s, i) => (
            <Reveal key={i} delayMs={i * 80}>
              <div className="relative h-full rounded-3xl border border-hairline bg-paper p-6 md:p-7 overflow-hidden group">
                <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-terracotta/10 blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
                  {s.kicker}
                </div>
                <h3 className="mt-3 font-display text-2xl leading-tight tracking-[-0.01em]">
                  {s.title}
                </h3>
                <p className="mt-3 text-sm text-ink-3 leading-relaxed">
                  {s.copy}
                </p>
                <div className="mt-5 inline-flex items-center gap-2 h-7 px-2.5 rounded-full border border-hairline bg-bone">
                  <span className="w-1.5 h-1.5 rounded-full bg-terracotta" />
                  <span className="font-mono text-[10px] tracking-wider uppercase text-ink-3">
                    {s.badge}
                  </span>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Features ---------------- */

function Features() {
  const features = [
    {
      title: "Menú editable en un toque",
      copy: "Agota un plato desde tu celular y desaparece de la carta al instante. Categorías, modificadores, fotos y precios — sin pedirle ayuda a tu diseñador.",
      icon: <IconMenu />,
    },
    {
      title: "Cocina en vivo, sin papel",
      copy: "Cada ronda entra con sus platos, notas y modificadores. La cocina marca listo y el salón se entera al segundo.",
      icon: <IconKitchen />,
    },
    {
      title: "Salón sin caos",
      copy: "Un tablero por mesa, rondas numeradas, timer de pase y fuertes juntos — tus meseros saben qué entregar y cuándo.",
      icon: <IconServe />,
    },
    {
      title: "Cuenta dividida sin drama",
      copy: "Todo, partes iguales o lo mío — tres modos que cubren el 100% de las discusiones en la mesa. Propina sugerida y editable.",
      icon: <IconSplit />,
    },
    {
      title: "Efectivo trazable",
      copy: "Si el cliente paga en efectivo, el mesero recibe el cobro en el salón, ingresa cuánto dio y cuánto devolvió. Las diferencias van al cierre como propina.",
      icon: <IconCash />,
    },
    {
      title: "Modo mostrador para food trucks",
      copy: "¿Carrito, ventana o food truck? Activa modo mostrador y trabajas con un único QR. Cada pedido es su propia orden, sin mesas ni mapas.",
      icon: <IconCounter />,
    },
    {
      title: "Pedido anticipado con prepago",
      copy: "Activa el QR de recogida y tus clientes ordenan desde afuera. Pagan con tarjeta o Nequi antes de que la cocina empiece y ven en vivo cuánto falta para recoger.",
      icon: <IconPickup />,
    },
    {
      title: "Reseñas por plato, no por ★",
      copy: "Cada plato puede recibir una reseña independiente. Sabes qué está gustando y qué hay que afinar en la cocina.",
      icon: <IconStar />,
    },
    {
      title: "Cierre de turno automático",
      copy: "Un CSV con cada pago del día por método, mesa y mesero. Listo para contabilidad o tu ERP.",
      icon: <IconClose />,
    },
    {
      title: "Multi-mesero, multi-rol",
      copy: "Operador, cocina, admin. Cada uno ve lo que necesita. Suspensiones y planes se gestionan desde el panel.",
      icon: <IconTeam />,
    },
  ];
  return (
    <section className="py-20 md:py-28 bg-paper/60 border-y border-hairline">
      <div className="max-w-6xl mx-auto px-5 md:px-8">
        <Reveal>
          <div className="max-w-2xl">
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-terracotta">
              Producto
            </div>
            <h2 className="mt-3 font-display text-4xl md:text-5xl leading-[1.05] tracking-[-0.015em]">
              Construido para el día a día real de un restaurante.
            </h2>
            <p className="mt-4 text-ink-3 text-lg">
              No es un POS genérico. Cada pantalla salió de horas adentro de la
              cocina, del salón y de la caja.
            </p>
          </div>
        </Reveal>

        <div className="mt-12 grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          {features.map((f, i) => (
            <Reveal key={i} delayMs={(i % 4) * 60}>
              <div className="h-full rounded-2xl border border-hairline bg-bone p-5 hover:-translate-y-0.5 hover:shadow-[0_20px_40px_rgba(26,22,19,0.06)] transition-all">
                <div className="w-10 h-10 rounded-xl bg-terracotta/10 text-terracotta flex items-center justify-center">
                  {f.icon}
                </div>
                <h3 className="mt-4 font-display text-xl leading-snug">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm text-ink-3 leading-relaxed">
                  {f.copy}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Benefits / Numbers ---------------- */

function Benefits() {
  return (
    <section id="beneficios" className="relative py-20 md:py-28 overflow-hidden">
      <div className="absolute inset-0 grain" aria-hidden />
      <div className="relative max-w-6xl mx-auto px-5 md:px-8">
        <div className="grid md:grid-cols-12 gap-10 items-start">
          <Reveal className="md:col-span-5">
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-terracotta">
              Lo que cambia
            </div>
            <h2 className="mt-3 font-display text-4xl md:text-5xl leading-[1.05] tracking-[-0.015em]">
              Menos fricción, más mesas, mejores propinas.
            </h2>
            <p className="mt-5 text-ink-3 text-lg">
              Lo que los números dicen cuando el cliente no tiene que levantar la
              mano para pedir la cuenta.
            </p>
            <div className="mt-6 rounded-2xl border border-hairline bg-paper p-4 text-sm text-ink-3">
              <p className="italic font-display text-xl leading-snug">
                “Antes, a las 9pm teníamos cinco mesas esperando la cuenta. Ahora
                están pagando mientras el cocinero saca el postre.”
              </p>
              <div className="mt-3 font-mono text-[10px] tracking-wider uppercase text-muted">
                — Operador, restaurante piloto
              </div>
            </div>
          </Reveal>

          <div className="md:col-span-7 grid grid-cols-2 gap-3 md:gap-4">
            <Reveal delayMs={0}>
              <StatCard
                label="Rotación de mesa"
                value={<StatCountUp value={18} suffix="%" />}
                sub="más rápida en horario pico"
              />
            </Reveal>
            <Reveal delayMs={80}>
              <StatCard
                label="Propina promedio"
                value={<StatCountUp value={22} suffix="%" />}
                sub="mayor vs. cuenta con mesero"
                accent
              />
            </Reveal>
            <Reveal delayMs={160}>
              <StatCard
                label="Errores en pedidos"
                value={<StatCountUp value={0} suffix="%" />}
                sub="sin papel, sin transcripción"
              />
            </Reveal>
            <Reveal delayMs={240}>
              <StatCard
                label="Tiempo para cerrar caja"
                value={
                  <span>
                    <StatCountUp value={3} format="decimal" />
                    <span className="text-lg ml-1 text-muted">min</span>
                  </span>
                }
                sub="con CSV del día listo"
              />
            </Reveal>
            <Reveal delayMs={320} className="col-span-2">
              <StatCard
                label="Lo que tú inviertes"
                value={
                  <span className="text-ink">
                    Desde <span className="tabular">$ 200.000</span>
                    <span className="text-lg ml-1 text-muted">/ mes</span>
                  </span>
                }
                sub="mensualidad fija, sin sorpresas"
                wide
              />
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
  wide,
}: {
  label: string;
  value: React.ReactNode;
  sub: string;
  accent?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      className={
        "rounded-2xl border p-5 h-full " +
        (accent
          ? "border-terracotta/30 bg-terracotta/5"
          : "border-hairline bg-paper") +
        (wide ? " flex items-center justify-between" : "")
      }
    >
      <div className={wide ? "" : ""}>
        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
          {label}
        </div>
        <div
          className={
            "font-display leading-none tracking-[-0.01em] mt-2 " +
            (wide ? "text-3xl md:text-4xl" : "text-4xl md:text-5xl")
          }
        >
          {value}
        </div>
        <div className="mt-2 text-xs text-ink-3">{sub}</div>
      </div>
    </div>
  );
}

/* ---------------- Flow strip ---------------- */

function FlowStrip() {
  const moments = [
    { t: "19:04", line: "Mesa 6 escanea el QR", tint: "ink" },
    { t: "19:07", line: "Ronda 1 — 3 entradas entran a cocina", tint: "olive" },
    { t: "19:21", line: "Cocina marca bandeja paisa lista", tint: "ok" },
    { t: "19:35", line: "Mesa pide cobro efectivo", tint: "terracotta" },
    { t: "19:36", line: "Mesero registra $ 100.000 · cambio $ 12.000", tint: "gold" },
    { t: "19:36", line: "Propina extra $ 0 → tip 10%", tint: "muted" },
    { t: "22:08", line: "Cierre de turno · 47 pagos · CSV listo", tint: "ink" },
  ];
  const tintClass: Record<string, string> = {
    ink: "text-ink bg-ink/10 border-ink/20",
    olive: "text-olive bg-olive/10 border-olive/25",
    ok: "text-ok bg-ok/10 border-ok/25",
    terracotta: "text-terracotta bg-terracotta/10 border-terracotta/30",
    gold: "text-gold bg-gold/10 border-gold/25",
    muted: "text-ink-3 bg-muted-2/10 border-hairline",
  };

  return (
    <section className="relative py-20 md:py-24 bg-ink text-bone overflow-hidden">
      <div className="absolute inset-0 opacity-40" aria-hidden>
        <div className="absolute inset-0 grid-bg" style={{ filter: "invert(1)" }} />
      </div>
      <div className="relative max-w-6xl mx-auto px-5 md:px-8">
        <Reveal>
          <div className="max-w-2xl">
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-terracotta-soft/80">
              Un servicio real
            </div>
            <h2 className="mt-3 font-display text-4xl md:text-5xl leading-[1.05] tracking-[-0.015em]">
              De 7 a 10pm, visto desde MESAPAY.
            </h2>
          </div>
        </Reveal>

        <div className="mt-10 relative">
          <div className="absolute left-6 md:left-8 top-0 bottom-0 w-px bg-bone/15" />
          <ul className="space-y-4">
            {moments.map((m, i) => (
              <Reveal key={i} delayMs={i * 60}>
                <li className="relative flex items-start gap-5 pl-12 md:pl-16">
                  <span
                    className={
                      "absolute left-[18px] md:left-[26px] top-1.5 w-3 h-3 rounded-full border bg-ink " +
                      tintClass[m.tint]
                    }
                  />
                  <span className="w-14 shrink-0 font-mono text-xs tabular text-bone/60">
                    {m.t}
                  </span>
                  <span className="text-base md:text-lg font-display leading-snug">
                    {m.line}
                  </span>
                </li>
              </Reveal>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Pricing ---------------- */

function Pricing() {
  const tiers = [
    {
      name: "Prueba",
      price: "$ 0",
      per: "por 14 días",
      copy: "Prueba MESAPAY sin costo durante 14 días, sin límite de mesas.",
      features: [
        "Mesas ilimitadas por 14 días",
        "Cocina + Salón + Pago",
        "Cierre de turno incluido",
        "Sin tarjeta de crédito",
      ],
      cta: { label: "Empezar prueba", href: "/signup/restaurant" },
      highlight: false,
    },
    {
      name: "Mostrador",
      price: "$ 150.000",
      per: "/ mes · COP",
      copy: "Punto de venta sin mesas: food trucks, cafés de ventana, mostradores.",
      features: [
        "Un único QR de mostrador",
        "Pedidos independientes",
        "Cocina + cierre de turno",
        "Operadores ilimitados",
      ],
      cta: { label: "Empezar en mostrador", href: "/signup/restaurant" },
      highlight: false,
    },
    {
      name: "Básico",
      price: "$ 200.000",
      per: "/ mes · COP",
      copy: "Para un restaurante consolidado, un turno, hasta 20 mesas.",
      features: [
        "Hasta 20 mesas",
        "Operadores ilimitados",
        "Reseñas por plato",
        "Soporte por correo",
      ],
      cta: { label: "Registrar restaurante", href: "/signup/restaurant" },
      highlight: true,
    },
    {
      name: "Pro",
      price: "$ 400.000",
      per: "/ mes · COP",
      copy: "Para cadenas o restaurantes con servicio continuo de alto volumen.",
      features: [
        "Mesas ilimitadas",
        "Multi-turno",
        "Integración de Pagos",
        "Soporte prioritario",
      ],
      cta: { label: "Hablar con ventas", href: "/signup/restaurant" },
      highlight: false,
    },
  ];

  return (
    <section id="planes" className="py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-5 md:px-8">
        <Reveal>
          <div className="max-w-2xl">
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-terracotta">
              Planes
            </div>
            <h2 className="mt-3 font-display text-4xl md:text-5xl leading-[1.05] tracking-[-0.015em]">
              Un precio plano, sin enredos.
            </h2>
            <p className="mt-4 text-ink-3 text-lg">
              Pagas una mensualidad fija mientras tus clientes ordenan y pagan
              desde su mesa.
            </p>
          </div>
        </Reveal>

        <div className="mt-12 grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          {tiers.map((t, i) => (
            <Reveal key={t.name} delayMs={i * 80}>
              <div
                className={
                  "relative h-full rounded-3xl p-6 md:p-7 border flex flex-col " +
                  (t.highlight
                    ? "bg-ink text-bone border-ink shadow-[0_30px_80px_rgba(26,22,19,0.2)]"
                    : "bg-paper text-ink border-hairline")
                }
              >
                {t.highlight && (
                  <div className="absolute -top-3 left-6 h-6 px-2.5 rounded-full bg-terracotta text-bone font-mono text-[10px] tracking-wider uppercase flex items-center">
                    Más elegido
                  </div>
                )}
                <div className="font-mono text-[10px] tracking-[0.18em] uppercase opacity-70">
                  {t.name}
                </div>
                <div className="mt-4 flex items-baseline gap-1.5 flex-wrap">
                  <span className="font-display text-5xl tracking-[-0.02em] tabular whitespace-nowrap">
                    {t.price}
                  </span>
                  <span className="font-mono text-xs opacity-70">{t.per}</span>
                </div>
                <p
                  className={
                    "mt-3 text-sm " + (t.highlight ? "text-bone/80" : "text-ink-3")
                  }
                >
                  {t.copy}
                </p>
                <ul className="mt-5 space-y-2 text-sm">
                  {t.features.map((f, j) => (
                    <li key={j} className="flex items-start gap-2">
                      <span
                        className={
                          "mt-0.5 " +
                          (t.highlight ? "text-terracotta-soft" : "text-terracotta")
                        }
                      >
                        <Check />
                      </span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-6">
                  <Link
                    href={t.cta.href}
                    className={
                      "h-11 w-full rounded-xl inline-flex items-center justify-center font-medium text-sm " +
                      (t.highlight
                        ? "bg-terracotta text-bone hover:bg-terracotta-2 transition-colors"
                        : "border border-hairline bg-bone hover:bg-cream transition-colors")
                    }
                  >
                    {t.cta.label}
                  </Link>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Live demo strip ---------------- */

function LiveDemoStrip({
  tenants,
}: {
  tenants: { slug: string; name: string }[];
}) {
  if (tenants.length === 0) return null;
  return (
    <section className="py-16 md:py-20 bg-paper/60 border-y border-hairline">
      <div className="max-w-6xl mx-auto px-5 md:px-8">
        <Reveal>
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <div>
              <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-terracotta">
                En vivo
              </div>
              <h2 className="mt-2 font-display text-3xl md:text-4xl tracking-[-0.015em]">
                Restaurantes que están usando MESAPAY
              </h2>
            </div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
              Escanea una carta real →
            </div>
          </div>
        </Reveal>
        <div className="mt-8 grid grid-cols-2 md:grid-cols-3 gap-3">
          {tenants.map((t, i) => (
            <Reveal key={t.slug} delayMs={i * 50}>
              <Link
                href={`/t/${t.slug}`}
                className="group block rounded-2xl border border-hairline bg-bone p-4 hover:border-terracotta/40 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="font-display text-xl leading-tight">
                    {t.name}
                  </div>
                  <span className="font-mono text-[10px] tracking-wider uppercase text-muted group-hover:text-terracotta transition-colors">
                    Ver →
                  </span>
                </div>
                <div className="mt-1 font-mono text-[10px] tracking-wider uppercase text-muted">
                  /{t.slug}
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Final CTA ---------------- */

function FinalCta() {
  return (
    <section className="py-20 md:py-28">
      <div className="max-w-4xl mx-auto px-5 md:px-8">
        <Reveal>
          <div className="relative rounded-3xl bg-ink text-bone p-8 md:p-14 overflow-hidden">
            <div className="absolute -right-20 -top-20 w-80 h-80 rounded-full bg-terracotta/30 blur-3xl" />
            <div className="absolute -left-20 -bottom-20 w-80 h-80 rounded-full bg-olive/20 blur-3xl" />
            <div className="relative">
              <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-terracotta-soft/90">
                Listo en una tarde
              </div>
              <h2 className="mt-3 font-display text-4xl md:text-6xl leading-[1.04] tracking-[-0.02em]">
                Convierte tus mesas en <em>cajas silenciosas</em>.
              </h2>
              <p className="mt-5 max-w-xl text-bone/75 text-lg">
                Tú sigues cocinando como siempre. MESAPAY se encarga de que nadie
                vuelva a pedir la cuenta.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Link
                  href="/signup/restaurant"
                  className="h-12 px-6 rounded-xl bg-terracotta text-bone font-medium inline-flex items-center gap-2 hover:bg-terracotta-2 transition-colors"
                >
                  Registrar mi restaurante
                  <span aria-hidden>→</span>
                </Link>
                <Link
                  href="/signin"
                  className="h-12 px-5 rounded-xl border border-bone/20 bg-bone/5 backdrop-blur text-bone font-medium inline-flex items-center"
                >
                  Ya tengo cuenta
                </Link>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------------- Footer ---------------- */

function SiteFooter() {
  return (
    <footer className="border-t border-hairline bg-paper/70">
      <div className="max-w-6xl mx-auto px-5 md:px-8 py-10 grid md:grid-cols-4 gap-6 text-sm">
        <div className="md:col-span-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-ink text-bone flex items-center justify-center text-[11px] font-mono">
              M
            </div>
            <span className="font-display text-xl">MESAPAY</span>
          </div>
          <p className="mt-3 text-ink-3 max-w-sm">
            Hecho en Colombia. Ordenar y pagar desde la mesa, sin apps ni filas.
          </p>
        </div>
        <div>
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-3">
            Producto
          </div>
          <ul className="space-y-2 text-ink-3">
            <li>
              <a href="#como-funciona" className="hover:text-ink">
                Cómo funciona
              </a>
            </li>
            <li>
              <a href="#beneficios" className="hover:text-ink">
                Beneficios
              </a>
            </li>
            <li>
              <a href="#planes" className="hover:text-ink">
                Planes
              </a>
            </li>
          </ul>
        </div>
        <div>
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-3">
            Empezar
          </div>
          <ul className="space-y-2 text-ink-3">
            <li>
              <Link href="/signup/restaurant" className="hover:text-ink">
                Registrar restaurante
              </Link>
            </li>
            <li>
              <Link href="/signup" className="hover:text-ink">
                Crear cuenta de cliente
              </Link>
            </li>
            <li>
              <Link href="/signin" className="hover:text-ink">
                Ingresar
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-hairline">
        <div className="max-w-6xl mx-auto px-5 md:px-8 py-5 flex flex-wrap items-center justify-between gap-3 font-mono text-[10px] tracking-wider uppercase text-muted">
          <span>© {new Date().getFullYear()} MESAPAY · Medellín</span>
          <span>Construido para meseros, cocineros y dueños.</span>
        </div>
      </div>
    </footer>
  );
}

/* ---------------- Icons ---------------- */

function IconBase({
  children,
  size = 20,
}: {
  children: React.ReactNode;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function IconMenu() {
  return (
    <IconBase>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </IconBase>
  );
}
function IconKitchen() {
  return (
    <IconBase>
      <path d="M5 4h14l-1 4H6L5 4Z" />
      <path d="M7 8v12h10V8" />
      <path d="M10 12h4" />
    </IconBase>
  );
}
function IconServe() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="7" />
      <path d="M4 19h16" />
      <path d="M10 11h4" />
    </IconBase>
  );
}
function IconSplit() {
  return (
    <IconBase>
      <path d="M4 6h6a4 4 0 0 1 4 4v8" />
      <path d="M20 6h-6a4 4 0 0 0-4 4v8" />
    </IconBase>
  );
}
function IconCash() {
  return (
    <IconBase>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M6 10v4M18 10v4" />
    </IconBase>
  );
}
function IconStar() {
  return (
    <IconBase>
      <path d="m12 4 2.5 5 5.5.8-4 3.9.95 5.5L12 16.9 7.05 19.2 8 13.7l-4-3.9L9.5 9 12 4Z" />
    </IconBase>
  );
}
function IconClose() {
  return (
    <IconBase>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </IconBase>
  );
}
function IconTeam() {
  return (
    <IconBase>
      <circle cx="9" cy="9" r="3" />
      <circle cx="17" cy="11" r="2.2" />
      <path d="M3 19c0-3 3-5 6-5s6 2 6 5" />
      <path d="M15 18c.4-2 2-3 4-3s3.5 1.2 4 3" />
    </IconBase>
  );
}
function IconCounter() {
  return (
    <IconBase>
      <path d="M3 11h18" />
      <path d="M5 11v8M19 11v8" />
      <path d="M3 19h18" />
      <rect x="7" y="4" width="10" height="7" rx="1.5" />
      <path d="M10 11V7M14 11V7" />
    </IconBase>
  );
}
function IconPickup() {
  return (
    <IconBase>
      <path d="M6 9h12l-1 10H7L6 9Z" />
      <path d="M9 9V6a3 3 0 0 1 6 0v3" />
      <path d="M10 14l1.5 1.5L15 12" />
    </IconBase>
  );
}
