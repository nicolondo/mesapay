"use client";

import { useEffect, useState } from "react";

const SCENES = ["scan", "menu", "pay"] as const;
type Scene = (typeof SCENES)[number];

export function HeroPhone({ qrSvg }: { qrSvg: string }) {
  const [scene, setScene] = useState<Scene>("scan");

  useEffect(() => {
    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % SCENES.length;
      setScene(SCENES[i]);
    }, 3200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="relative w-[280px] md:w-[320px] mx-auto">
      {/* Phone frame */}
      <div className="relative float-y">
        <div className="rounded-[44px] bg-ink p-2 shadow-[0_30px_80px_rgba(26,22,19,0.22),0_8px_24px_rgba(26,22,19,0.12)]">
          <div className="relative rounded-[36px] overflow-hidden bg-bone h-[600px] md:h-[640px]">
            {/* Notch */}
            <div className="absolute left-1/2 -translate-x-1/2 top-2.5 w-24 h-5 rounded-full bg-ink z-20" />

            {/* Status bar */}
            <div className="absolute top-3 left-5 right-5 flex items-center justify-between text-[10px] font-mono text-ink/80 z-10">
              <span>9:41</span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-1.5 rounded-sm bg-ink/70" />
                <span className="inline-block w-2 h-1.5 rounded-sm bg-ink/50" />
                <span className="inline-block w-4 h-1.5 rounded-sm bg-ok/80" />
              </span>
            </div>

            <Scenes scene={scene} qrSvg={qrSvg} />
          </div>
        </div>
        {/* Subtle terracotta glow */}
        <div className="absolute inset-0 -z-10 rounded-[44px] bg-terracotta/20 blur-3xl" />
      </div>

      {/* Scene dots */}
      <div className="mt-5 flex items-center justify-center gap-1.5">
        {SCENES.map((s) => (
          <span
            key={s}
            className={
              "h-1.5 rounded-full transition-all duration-500 " +
              (scene === s ? "w-6 bg-ink" : "w-1.5 bg-ink/20")
            }
          />
        ))}
      </div>
    </div>
  );
}

function Scenes({ scene, qrSvg }: { scene: Scene; qrSvg: string }) {
  return (
    <div className="absolute inset-0 pt-12">
      <SceneContainer active={scene === "scan"}>
        <ScanScene qrSvg={qrSvg} />
      </SceneContainer>
      <SceneContainer active={scene === "menu"}>
        <MenuScene />
      </SceneContainer>
      <SceneContainer active={scene === "pay"}>
        <PayScene />
      </SceneContainer>
    </div>
  );
}

function SceneContainer({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        "absolute inset-0 pt-12 px-5 pb-6 transition-all duration-700 " +
        (active
          ? "opacity-100 translate-y-0"
          : "opacity-0 translate-y-3 pointer-events-none")
      }
    >
      {children}
    </div>
  );
}

function ScanScene({ qrSvg }: { qrSvg: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center">
      <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-muted">
        Mesa 7
      </div>
      <div className="font-display text-xl mt-1">La Bogotana</div>

      <div className="relative mt-6 w-48 h-48 rounded-3xl border-2 border-ink/80 overflow-hidden bg-paper p-3">
        <div
          className="w-full h-full [&_svg]:w-full [&_svg]:h-full"
          dangerouslySetInnerHTML={{ __html: qrSvg }}
        />
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="scan-beam absolute left-0 right-0 h-14 bg-gradient-to-b from-transparent via-terracotta/55 to-transparent" />
        </div>
        <div className="absolute -inset-2 rounded-3xl border border-terracotta/30 pulse-ring" />
        <div className="absolute -inset-2 rounded-3xl border border-terracotta/20 pulse-ring-slow" />
      </div>

      <div className="mt-6 text-center">
        <div className="text-sm">Escanea el QR</div>
        <div className="text-xs text-muted mt-0.5">
          Sin app. Sin cuenta. Sin esperas.
        </div>
      </div>
    </div>
  );
}

function MenuScene() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-muted">
            Carta · Mesa 7
          </div>
          <div className="font-display text-xl">Platos fuertes</div>
        </div>
        <div className="h-7 px-2 rounded-full bg-ink text-bone text-[11px] font-medium inline-flex items-center gap-1">
          <span className="tabular">3</span>
          <span className="opacity-70">ítems</span>
        </div>
      </div>

      <div className="mt-4 space-y-2.5">
        <MenuRow
          name="Bandeja paisa"
          desc="Frijol, carne, chicharrón, huevo"
          price="32.000"
          delay="0.1s"
        />
        <MenuRow
          name="Pasta bolognesa"
          desc="Con queso parmesano"
          price="28.000"
          delay="0.3s"
          highlight
        />
        <MenuRow
          name="Arepa de choclo"
          desc="Queso fresco y mantequilla"
          price="14.000"
          delay="0.5s"
        />
      </div>

      <div className="mt-auto pt-4 border-t border-hairline">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[9px] tracking-[0.16em] uppercase text-muted">
              Tu pedido
            </div>
            <div className="font-display text-xl tabular">$ 74.000</div>
          </div>
          <div className="h-10 px-4 rounded-full bg-terracotta text-bone inline-flex items-center text-sm font-medium">
            Pagar
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuRow({
  name,
  desc,
  price,
  delay,
  highlight,
}: {
  name: string;
  desc: string;
  price: string;
  delay: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={
        "fade-up rounded-xl border p-2.5 flex items-center gap-2.5 " +
        (highlight
          ? "border-terracotta/35 bg-terracotta/5"
          : "border-hairline bg-paper")
      }
      style={{ animationDelay: delay }}
    >
      <div
        className={
          "w-10 h-10 rounded-lg flex items-center justify-center font-display text-lg " +
          (highlight ? "bg-terracotta/20 text-terracotta" : "bg-cream text-ink")
        }
      >
        {name[0]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{name}</div>
        <div className="text-[10px] text-muted truncate">{desc}</div>
      </div>
      <div className="font-mono text-xs tabular text-ink">${price}</div>
    </div>
  );
}

function PayScene() {
  return (
    <div className="h-full flex flex-col">
      <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-muted">
        Pagar · Mesa 7
      </div>
      <div className="font-display text-xl mt-1">Dividir la cuenta</div>

      <div className="mt-4 grid grid-cols-3 gap-1.5">
        <PayChip label="Todo" />
        <PayChip label="Partes" active />
        <PayChip label="Lo mío" />
      </div>

      <div className="mt-4 rounded-xl border border-hairline bg-paper p-3">
        <Row label="Subtotal" value="$ 74.000" />
        <Row label="Propina 10%" value="$ 7.400" muted />
        <div className="border-t border-hairline mt-2 pt-2 flex items-baseline justify-between">
          <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted">
            Tu parte (1/3)
          </span>
          <span className="font-display text-2xl tabular">$ 27.133</span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1">
        <PayMethod label="Tarjeta" hint="Débito o crédito" />
        <PayMethod label="Nequi" hint="Transferencia" active />
        <PayMethod label="Apple Pay" hint="Face ID" />
        <PayMethod label="Google Pay" hint="1 toque" />
        <PayMethod label="PSE" hint="Bancolombia · Dav…" />
        <PayMethod label="USDT" hint="Cripto · TRC-20" />
        <PayMethod label="Efectivo" hint="Llamar al mesero" />
      </div>

      <div className="mt-auto pt-3">
        <div className="h-11 rounded-full bg-ok text-bone text-sm font-medium flex items-center justify-center gap-2">
          <span className="w-5 h-5 rounded-full bg-bone/20 flex items-center justify-center text-xs">
            ✓
          </span>
          Pagar $ 27.133
        </div>
      </div>
    </div>
  );
}

function PayChip({ label, active }: { label: string; active?: boolean }) {
  return (
    <div
      className={
        "h-8 rounded-lg text-[11px] flex items-center justify-center border " +
        (active
          ? "bg-ink text-bone border-ink"
          : "bg-paper text-ink border-hairline")
      }
    >
      {label}
    </div>
  );
}

function PayMethod({
  label,
  hint,
  active,
}: {
  label: string;
  hint: string;
  active?: boolean;
}) {
  return (
    <div
      className={
        "rounded-lg border px-2.5 py-1.5 flex items-center justify-between " +
        (active
          ? "bg-ink text-bone border-ink"
          : "bg-paper text-ink border-hairline")
      }
    >
      <div className="min-w-0">
        <div className="text-[11px] font-medium leading-tight">{label}</div>
        <div className="text-[9px] opacity-70 truncate leading-tight">{hint}</div>
      </div>
      <div
        className={
          "w-3.5 h-3.5 rounded-full border shrink-0 " +
          (active ? "border-bone bg-bone/25" : "border-hairline")
        }
      />
    </div>
  );
}

function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className={"text-[11px] " + (muted ? "text-muted" : "")}>
        {label}
      </span>
      <span className="font-mono text-xs tabular">{value}</span>
    </div>
  );
}

