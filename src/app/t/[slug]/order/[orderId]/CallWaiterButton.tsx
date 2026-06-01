"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function CallWaiterButton({
  tenantSlug,
  orderId,
  initialNeedsWaiter,
  initialCalledAtISO,
}: {
  tenantSlug: string;
  orderId: string;
  initialNeedsWaiter: boolean;
  initialCalledAtISO: string | null;
}) {
  const router = useRouter();
  const t = useTranslations("order");
  const [optimisticCalled, setOptimisticCalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTx] = useTransition();

  const called = initialNeedsWaiter || optimisticCalled;
  const calledAtISO =
    initialCalledAtISO ?? (optimisticCalled ? new Date().toISOString() : null);

  useEffect(() => {
    if (!initialNeedsWaiter && optimisticCalled) setOptimisticCalled(false);
  }, [initialNeedsWaiter, optimisticCalled]);

  async function call() {
    setBusy(true);
    setErr(null);
    setOptimisticCalled(true);
    try {
      navigator.vibrate?.([40, 30, 40]);
    } catch {}
    const res = await fetch(
      `/api/tenant/${tenantSlug}/orders/${orderId}/call-waiter`,
      { method: "POST" },
    );
    setBusy(false);
    if (!res.ok) {
      setOptimisticCalled(false);
      setErr(t("errCallWaiter"));
      return;
    }
    startTx(() => router.refresh());
  }

  if (called) {
    return (
      <div className="rounded-xl border border-terracotta/40 bg-terracotta/10 px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-full bg-terracotta/20 text-terracotta inline-flex items-center justify-center shrink-0">
            <BellIcon />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              {t("waiterOnWay")}
            </div>
            {calledAtISO && (
              <CalledAgo atISO={calledAtISO} />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={call}
        disabled={busy}
        className="h-11 w-full rounded-xl border border-hairline bg-paper text-ink text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.99] transition-transform disabled:opacity-60"
      >
        <span className="text-terracotta">
          <BellIcon />
        </span>
        {busy ? t("calling") : t("callWaiter")}
      </button>
      {err && <div className="mt-1 text-xs text-danger">{err}</div>}
    </div>
  );
}

function CalledAgo({ atISO }: { atISO: string }) {
  const t = useTranslations("order");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - new Date(atISO).getTime()) / 1000));
  const label =
    secs < 30
      ? t("calledJustNow")
      : secs < 60
        ? t("calledLessMin")
        : t("calledAgoMin", { min: Math.floor(secs / 60) });
  return <div className="text-[11px] text-muted truncate">{label}</div>;
}

function BellIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
