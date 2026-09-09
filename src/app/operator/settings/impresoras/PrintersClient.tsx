"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  agentLiveness,
  humanizeAgo,
  type AgentState,
} from "@/lib/print/agentStatus";

type PrinterView = {
  id: string;
  localKey: string | null;
  label: string;
  host: string;
  port: number;
  /** "comanda" | "factura" — qué imprime. */
  kind: string;
  /** null en una impresora de factura: no sirve a ninguna estación. */
  station: string | null;
  barSubStation: string | null;
  paperWidthMm: number | null;
  active: boolean;
};

/**
 * Orden de los grupos en la pantalla: primero las de comanda (son las
 * que hay en todos los locales), después la de facturas. Un local sin
 * impresora de facturas no ve un grupo vacío.
 */
const KIND_ORDER = ["comanda", "factura"] as const;

function groupByKind(printers: PrinterView[]): Array<{
  kind: string;
  printers: PrinterView[];
}> {
  const groups = KIND_ORDER.map((kind) => ({
    kind: kind as string,
    printers: printers.filter((p) => p.kind === kind),
  }));
  // Un `kind` que este build no conoce igual tiene que verse: una
  // impresora invisible que recibe trabajos es peor que una de más.
  const known = new Set<string>(KIND_ORDER);
  const rest = printers.filter((p) => !known.has(p.kind));
  for (const p of rest) {
    const g = groups.find((x) => x.kind === p.kind);
    if (g) g.printers.push(p);
    else groups.push({ kind: p.kind, printers: [p] });
  }
  return groups.filter((g) => g.printers.length > 0);
}

type AgentView = {
  id: string;
  label: string;
  tokenTail: string | null;
  lastSeenAt: string | null;
  agentVersion: string | null;
  lastIp: string | null;
  revokedAt: string | null;
  printers: PrinterView[];
};

type JobView = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  printerId: string;
  printerLabel: string;
  printerActive: boolean;
};

/** Cada cuánto se vuelven a pedir los datos del servidor. */
const REFRESH_MS = 30 * 1000;
/** Cada cuánto se recalcula el "hace X" sin ir al servidor. */
const TICK_MS = 5 * 1000;

const STATE_TINT: Record<AgentState, string> = {
  online: "bg-ok/15 text-[#1E5339] border-ok/30",
  late: "bg-[#C98A2E]/20 text-[#8F6828] border-[#C98A2E]/30",
  offline: "bg-danger/10 text-danger border-danger/30",
  never: "bg-paper text-op-muted border-op-border",
};

const JOB_TINT: Record<string, string> = {
  pending: "bg-paper text-op-muted",
  delivered: "bg-[#C98A2E]/20 text-[#8F6828]",
  printed: "bg-ok/15 text-[#1E5339]",
  failed: "bg-danger/10 text-danger",
};

export function PrintersClient({
  agents,
  orphanPrinters,
  jobs,
  defaultPaperWidthMm,
  serverNow,
}: {
  agents: AgentView[];
  orphanPrinters: PrinterView[];
  jobs: JobView[];
  defaultPaperWidthMm: number;
  serverNow: string;
}) {
  const t = useTranslations("opPrinters");
  const router = useRouter();

  // El primer render usa la hora del SERVIDOR para que la hidratación
  // coincida; recién en el efecto se pasa al reloj del navegador.
  const [now, setNow] = useState(() => new Date(serverNow).getTime());
  // El token en claro sólo vive acá, en memoria, hasta que el operador
  // cierra el aviso. No vuelve a existir en ningún lado.
  const [freshToken, setFreshToken] = useState<{
    label: string;
    token: string;
  } | null>(null);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    // La pantalla contesta "¿la cocina está viva AHORA?": si no se
    // refresca sola, el operador la deja abierta y lee un estado viejo.
    const reload = setInterval(() => router.refresh(), REFRESH_MS);
    return () => {
      clearInterval(tick);
      clearInterval(reload);
    };
  }, [router]);

  return (
    <div className="space-y-3">
      {freshToken && (
        <TokenPanel
          label={freshToken.label}
          token={freshToken.token}
          onDismiss={() => setFreshToken(null)}
        />
      )}

      {agents.length === 0 && (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-6 text-center text-sm text-op-muted">
          {t("agentsEmpty")}
        </div>
      )}

      {agents.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          now={now}
          defaultPaperWidthMm={defaultPaperWidthMm}
        />
      ))}

      {orphanPrinters.length > 0 && (
        <div className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            {t("printersTitle")}
          </div>
          <PrinterGroups
            printers={orphanPrinters}
            defaultPaperWidthMm={defaultPaperWidthMm}
          />
        </div>
      )}

      <NewAgentForm onCreated={setFreshToken} />

      <JobsCard jobs={jobs} now={now} />
    </div>
  );
}

/**
 * El token en claro. Se muestra una sola vez: en la DB queda el SHA-256 y
 * nada más, así que "reenviar" no existe. El aviso tiene que decirlo con
 * todas las letras ANTES de que el operador cierre la pestaña.
 */
function TokenPanel({
  label,
  token,
  onDismiss,
}: {
  label: string;
  token: string;
  onDismiss: () => void;
}) {
  const t = useTranslations("opPrinters");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Sin permiso de portapapeles queda la selección manual: el token
      // está a la vista, que es lo que importa.
      setCopied(false);
    }
  }

  return (
    <div className="rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 p-5">
      <div className="font-display text-lg text-[#7F5A1F]">
        {t("tokenTitle", { label })}
      </div>
      <p className="text-sm text-[#7F5A1F] mt-1 mb-3">{t("tokenWarning")}</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg border border-op-border bg-op-bg px-3 py-2 text-xs font-mono select-all">
          {token}
        </code>
        <button type="button" onClick={copy} className="mp-btn mp-btn--primary mp-btn--sm">
          {copied ? t("tokenCopied") : t("tokenCopy")}
        </button>
      </div>
      <p className="text-[11px] text-[#7F5A1F] mt-2">{t("tokenHint")}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="mp-btn mp-btn--ghost mp-btn--sm mt-3"
      >
        {t("tokenDone")}
      </button>
    </div>
  );
}

function NewAgentForm({
  onCreated,
}: {
  onCreated: (v: { label: string; token: string }) => void;
}) {
  const t = useTranslations("opPrinters");
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!label.trim()) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/operator/print-agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: label.trim() }),
    });
    const j = (await res.json().catch(() => null)) as {
      token?: string;
      agent?: { label?: string };
    } | null;
    setBusy(false);
    if (!res.ok || !j?.token) {
      setErr(t("addAgentFailed"));
      return;
    }
    onCreated({ label: j.agent?.label ?? label.trim(), token: j.token });
    setLabel("");
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {t("addAgentTitle")}
      </div>
      <p className="text-[11px] text-op-muted mb-3">{t("agentsIntro")}</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("addAgentPlaceholder")}
          className="flex-1 h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
        />
        <button
          type="button"
          onClick={create}
          disabled={busy || !label.trim()}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {busy ? t("addAgentBusy") : t("addAgentBtn")}
        </button>
      </div>
      {err && <div className="mt-2 text-xs text-danger">{err}</div>}
    </div>
  );
}

function AgentCard({
  agent,
  now,
  defaultPaperWidthMm,
}: {
  agent: AgentView;
  now: number;
  defaultPaperWidthMm: number;
}) {
  const t = useTranslations("opPrinters");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const revoked = !!agent.revokedAt;
  const live = agentLiveness(agent.lastSeenAt, new Date(now));

  // "Responde hace 40 s" / "Sin responder hace 12 min": el estado solo
  // ("sin responder") no dice si hay que ir corriendo a la cocina o si
  // el PC lleva media hora apagado. El "hace cuánto" sí.
  const stateKey =
    live.state === "online"
      ? "stateOnline"
      : live.state === "late"
        ? "stateLate"
        : "stateOffline";
  const stateLabel = revoked
    ? t("agentRevoked")
    : live.ago
      ? `${t(stateKey)} ${t(agoKey(live.ago.unit), { n: live.ago.value })}`
      : t("stateNever");

  async function revoke() {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/operator/print-agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revoked: true }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(t("revokeFailed"));
      return;
    }
    setConfirming(false);
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-display text-xl truncate">{agent.label}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-op-muted mt-1">
            {agent.tokenTail && (
              <span className="font-mono">
                {t("tokenTail", { tail: agent.tokenTail })}
              </span>
            )}
            <span>
              {agent.agentVersion
                ? t("agentVersion", { version: agent.agentVersion })
                : t("agentVersionUnknown")}
            </span>
            <span>
              {agent.lastIp
                ? t("agentIp", { ip: agent.lastIp })
                : t("agentIpUnknown")}
            </span>
          </div>
        </div>
        <span
          className={
            "px-3 h-7 inline-flex items-center rounded-full text-[11px] font-medium border " +
            (revoked
              ? "bg-danger/10 text-danger border-danger/30"
              : STATE_TINT[live.state])
          }
        >
          {stateLabel}
        </span>
      </div>

      {revoked ? (
        <p className="text-[11px] text-op-muted mt-2">{t("agentRevokedHint")}</p>
      ) : (
        live.state === "never" && (
          <p className="text-[11px] text-op-muted mt-2">{t("stateNeverHint")}</p>
        )
      )}

      {/* Impresoras — de sólo lectura salvo el interruptor. */}
      <div className="mt-4 pt-4 border-t border-op-border">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
          {t("printersTitle")}
        </div>
        <p className="text-[11px] text-op-muted mb-3">{t("printersReadOnly")}</p>
        {agent.printers.length === 0 ? (
          <div className="text-sm text-op-muted">{t("printersEmpty")}</div>
        ) : (
          <PrinterGroups
            printers={agent.printers}
            defaultPaperWidthMm={defaultPaperWidthMm}
          />
        )}
      </div>

      {!revoked && (
        <div className="mt-4 pt-4 border-t border-op-border">
          {confirming ? (
            <div className="rounded-xl border border-danger/30 bg-danger/5 p-4">
              <div className="text-sm font-medium text-danger">
                {t("revokeConfirmTitle", { label: agent.label })}
              </div>
              <p className="text-[11px] text-op-muted mt-1 mb-3">
                {t("revokeConfirmBody")}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={revoke}
                  disabled={busy}
                  className="mp-btn mp-btn--danger-solid mp-btn--sm"
                >
                  {busy ? t("revokeBusy") : t("revokeConfirmBtn")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className="mp-btn mp-btn--secondary mp-btn--sm"
                >
                  {t("revokeCancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="mp-btn mp-btn--danger mp-btn--sm"
            >
              {t("revokeBtn")}
            </button>
          )}
          {err && <div className="mt-2 text-xs text-danger">{err}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * Las impresoras agrupadas por lo que IMPRIMEN. Tres en la cocina y una
 * en la caja mezcladas en una lista plana obligan a leer letra por letra
 * cuál es cuál; la pregunta que se hace quien mira esta pantalla es "¿la
 * de facturas está viva?", y así se contesta de un vistazo.
 */
function PrinterGroups({
  printers,
  defaultPaperWidthMm,
}: {
  printers: PrinterView[];
  defaultPaperWidthMm: number;
}) {
  const t = useTranslations("opPrinters");
  const groups = groupByKind(printers);

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const key = `printersGroup_${group.kind}`;
        return (
          <div key={group.kind}>
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1.5">
              {t.has(key) ? t(key) : group.kind}
            </div>
            <ul className="space-y-2">
              {group.printers.map((p) => (
                <PrinterRow
                  key={p.id}
                  printer={p}
                  defaultPaperWidthMm={defaultPaperWidthMm}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function PrinterRow({
  printer,
  defaultPaperWidthMm,
}: {
  printer: PrinterView;
  defaultPaperWidthMm: number;
}) {
  const t = useTranslations("opPrinters");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  // Una impresora de factura no tiene estación: en su lugar se rotula qué
  // imprime, que es lo único que la distingue de las de cocina.
  const kindKey = `kind_${printer.kind}`;
  const stationLabel = printer.barSubStation
    ? t("stationBarSub", { sub: printer.barSubStation })
    : printer.station
      ? t(`station_${printer.station}`)
      : t.has(kindKey)
        ? t(kindKey)
        : printer.kind;

  async function toggle() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/operator/printers/${printer.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !printer.active }),
    });
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "error", text: t("printerToggleFailed") });
      return;
    }
    startTransition(() => router.refresh());
  }

  async function testPrint() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(
      `/api/operator/printers/${printer.id}/test-print`,
      { method: "POST" },
    );
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "error", text: t("testFailed") });
      return;
    }
    setMsg({ kind: "ok", text: t("testQueued") });
    startTransition(() => router.refresh());
  }

  const disabled = busy || pending;

  return (
    <li className="rounded-xl border border-op-border bg-op-bg p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{printer.label}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-op-muted mt-0.5">
            <span>{stationLabel}</span>
            <span className="font-mono">
              {t("printerAddress", { host: printer.host, port: printer.port })}
            </span>
            <span>
              {printer.paperWidthMm
                ? t("printerPaper", { mm: printer.paperWidthMm })
                : t("printerPaperInherited", { mm: defaultPaperWidthMm })}
            </span>
          </div>
        </div>
        <span
          className={
            "px-2.5 h-6 inline-flex items-center rounded-full text-[10px] font-medium " +
            (printer.active
              ? "bg-ok/15 text-[#1E5339]"
              : "bg-paper text-op-muted")
          }
        >
          {printer.active ? t("printerActive") : t("printerInactive")}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={testPrint}
          disabled={disabled || !printer.active}
          className="mp-btn mp-btn--secondary mp-btn--sm"
        >
          {busy ? t("testBusy") : t("testBtn")}
        </button>
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          className="mp-btn mp-btn--ghost mp-btn--sm"
        >
          {printer.active ? t("printerTurnOff") : t("printerTurnOn")}
        </button>
        <span className="text-[11px] text-op-muted">
          {printer.active ? t("printerToggleHint") : t("testInactiveHint")}
        </span>
      </div>

      {msg && (
        <div
          className={
            "mt-2 text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")
          }
        >
          {msg.text}
        </div>
      )}
    </li>
  );
}

function JobsCard({ jobs, now }: { jobs: JobView[]; now: number }) {
  const t = useTranslations("opPrinters");

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-display text-lg">{t("jobsTitle")}</div>
      <p className="text-sm text-op-muted mt-1 mb-4">{t("jobsIntro")}</p>
      {jobs.length === 0 ? (
        <div className="text-sm text-op-muted">{t("jobsEmpty")}</div>
      ) : (
        <ul className="space-y-2">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function JobRow({ job, now }: { job: JobView; now: number }) {
  const t = useTranslations("opPrinters");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const age = humanizeAgo(Math.max(0, now - new Date(job.createdAt).getTime()));
  // `PrintJob.kind` es String y no enum a propósito (el próximo tipo de
  // documento no debería costar una migración), así que uno desconocido
  // se muestra crudo en vez de romper la lista.
  const kindKey = `jobKind_${job.kind}`;
  const kindLabel = t.has(kindKey) ? t(kindKey) : job.kind;

  async function retry() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/operator/print-jobs/${job.id}/retry`, {
      method: "POST",
    });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setMsg({
        kind: "error",
        text:
          j?.error === "printer_inactive"
            ? t("retryPrinterInactive")
            : t("retryFailed"),
      });
      return;
    }
    setMsg({ kind: "ok", text: t("retryQueued") });
    router.refresh();
  }

  return (
    <li className="rounded-xl border border-op-border bg-op-bg p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span>{kindLabel}</span>
            <span className="text-op-muted truncate">{job.printerLabel}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-op-muted mt-0.5">
            {age && <span>{t(agoKey(age.unit), { n: age.value })}</span>}
            {job.attempts > 0 && (
              <span>{t("jobAttempts", { count: job.attempts })}</span>
            )}
          </div>
          {job.lastError && (
            <div className="text-[11px] text-danger font-mono mt-1 break-all">
              {job.lastError}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={
              "px-2.5 h-6 inline-flex items-center rounded-full text-[10px] font-medium " +
              (JOB_TINT[job.status] ?? "bg-paper text-op-muted")
            }
          >
            {t(`jobStatus_${job.status}`)}
          </span>
          <button
            type="button"
            onClick={retry}
            disabled={busy || !job.printerActive}
            className="mp-btn mp-btn--ghost mp-btn--sm"
          >
            {busy ? t("retryBusy") : t("retryBtn")}
          </button>
        </div>
      </div>
      {msg && (
        <div
          className={
            "mt-2 text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")
          }
        >
          {msg.text}
        </div>
      )}
    </li>
  );
}

/** "minutes" → "agoMinutes". Las 4 claves existen en los 3 catálogos. */
function agoKey(unit: "seconds" | "minutes" | "hours" | "days"): string {
  return "ago" + unit.charAt(0).toUpperCase() + unit.slice(1);
}
