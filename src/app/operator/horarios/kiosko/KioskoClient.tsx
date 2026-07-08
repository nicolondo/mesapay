"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import {
  captureVideoFrame,
  detectFaceDescriptor,
  loadFaceApi,
} from "../faceApi";

/* ───────────────────────────── Tipos ───────────────────────────────── */
// Espejo de GET /api/operator/attendance/roster (C2 · D1): descriptores
// de 128 floats (1-3 por empleado) o null (sin registro facial o sin
// consentimiento → solo selección manual).

type RosterEmployee = {
  id: string;
  name: string;
  position: string;
  faceDescriptors: number[][] | null;
};

type Kind = "in" | "out";

/**
 * Máquina de estados del flujo de marcación. Cada pantalla es un paso;
 * las transiciones viven en efectos/handlers y siempre son objetos
 * nuevos (los efectos por paso se re-arman al cambiar de paso).
 */
type Step =
  | { s: "idle" }
  | { s: "camera"; kind: Kind }
  | { s: "detecting"; kind: Kind }
  | { s: "confirm"; kind: Kind; emp: RosterEmployee; distance: number }
  | { s: "manual"; kind: Kind; reason: ManualReason }
  | { s: "saving"; kind: Kind }
  | { s: "done"; kind: Kind; name: string; time: string; implicit: boolean }
  | { s: "fail"; msgKey: string };

type ManualReason = "no_match" | "no_face" | "camera_denied" | "face_error" | null;

/* ─────────────────────────── Constantes ────────────────────────────── */

/** Umbral de distancia euclidiana del spec (D1): mejor match < 0.5. */
const MATCH_THRESHOLD = 0.5;
/** Auto-captura a los 3 s (con botón manual para no esperar). */
const AUTO_CAPTURE_SECONDS = 3;
/** "Hola, {nombre}" auto-confirma a los 3 s. */
const CONFIRM_SECONDS = 3;
/** Éxito/error vuelven solos a la pantalla inicial a los 4 s. */
const RESULT_SECONDS = 4;

// Hora del dispositivo (= la del comercio en la práctica): el reloj, el
// punch (date/nowMinutes) y la hora del mensaje de éxito usan la misma
// zona — mismo criterio DEVICE_TZ del planner de horarios.
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Errores del POST punch → clave i18n (fallback errSaveFailed).
const PUNCH_ERROR_KEYS: Record<string, string> = {
  already_punched: "kioskErrAlreadyPunched",
  no_open_shift: "kioskErrNoOpenShift",
  employee_inactive: "errEmployeeInactive",
  employee_not_found: "errEmployeeNotFound",
};

// Por qué se cayó al selector manual → aviso i18n.
const MANUAL_NOTICE_KEYS: Record<Exclude<ManualReason, null>, string> = {
  no_match: "kioskNoMatch",
  no_face: "kioskNoFace",
  camera_denied: "kioskCameraDenied",
  face_error: "kioskFaceUnavailable",
};

/* ─────────────────────────── Helpers puros ─────────────────────────── */
// face-api (carga perezosa + captura de frame): compartido con el
// enrolamiento del tab Equipo — ver ../faceApi.ts.

/** Fecha y minuto LOCAL del dispositivo — contrato del POST punch. */
function localPunchClock(): { date: string; nowMinutes: number } {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    nowMinutes: d.getHours() * 60 + d.getMinutes(),
  };
}

function euclidean(a: Float32Array, b: number[]): number {
  let sum = 0;
  for (let i = 0; i < b.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Mejor match del roster: distancia mínima contra TODOS los descriptores
 * de todos los empleados; gana si queda bajo el umbral del spec.
 */
function bestMatch(
  descriptor: Float32Array,
  employees: RosterEmployee[],
): { emp: RosterEmployee; distance: number } | null {
  let best: { emp: RosterEmployee; distance: number } | null = null;
  for (const emp of employees) {
    for (const ref of emp.faceDescriptors ?? []) {
      if (!Array.isArray(ref) || ref.length !== descriptor.length) continue;
      const d = euclidean(descriptor, ref);
      if (!best || d < best.distance) best = { emp, distance: d };
    }
  }
  return best && best.distance < MATCH_THRESHOLD ? best : null;
}

/** confidence del punch = 1 − distancia (solo con match facial). */
function confidenceFrom(distance: number): number {
  return Math.min(1, Math.max(0, Math.round((1 - distance) * 1000) / 1000));
}

/** Búsqueda sin tildes ni mayúsculas ("jose" encuentra "José"). */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/* ───────────────────────────── Kiosko ──────────────────────────────── */

export function KioskoClient() {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  const [step, setStep] = useState<Step>({ s: "idle" });
  // Reloj: null hasta montar (el server no conoce la hora de la tablet —
  // renderizar new Date() rompería purity/hidratación). El interval
  // actualiza vía setState en su callback, patrón permitido para timers.
  const [now, setNow] = useState<Date | null>(null);
  const [roster, setRoster] = useState<RosterEmployee[] | null>(null);
  const [rosterErr, setRosterErr] = useState(false);
  const [rosterSeq, setRosterSeq] = useState(0);
  const [modelsReady, setModelsReady] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Frame capturado (input del match y fuente de la foto de evidencia). */
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Foto JPEG lista para subir (best-effort — la asistencia manda). */
  const photoRef = useRef<Blob | null>(null);
  /** Captura manual desde el botón — la implementa el efecto de cámara. */
  const captureRef = useRef<() => void>(() => {});
  /** Anti doble-punch: auto-confirm y tap pueden disparar en el mismo tick. */
  const punchingRef = useRef(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  /* Reloj por segundo (solo en cliente). El primer tick va en un timeout
     de 0 ms: setState solo en callbacks de timer, nunca en el cuerpo del
     efecto (regla react-hooks/set-state-in-effect). */
  useEffect(() => {
    const first = setTimeout(() => setNow(new Date()), 0);
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  /* Roster de empleados activos (con retry manual). */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/attendance/roster");
        if (!r.ok) throw new Error("load_failed");
        const j = (await r.json()) as { employees: RosterEmployee[] };
        if (cancelled) return;
        setRoster(j.employees);
        setRosterErr(false);
      } catch {
        if (!cancelled) setRosterErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rosterSeq]);

  /* Precarga de face-api al montar: el kiosko es una página dedicada —
     esconder los ~6 MB de modelos acá evita esperarlos en la primera
     marcación. Si falla, la captura reintenta (loadFaceApi se resetea). */
  useEffect(() => {
    let cancelled = false;
    loadFaceApi().then(
      () => {
        if (!cancelled) setModelsReady(true);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /* Cámara: enciende al entrar al paso, captura (auto a los 3 s o con el
     botón) y SIEMPRE apaga tracks al salir del paso o desmontar. */
  useEffect(() => {
    if (step.s !== "camera") return;
    const kind = step.kind;
    let cancelled = false;
    let captured = false;

    const doCapture = () => {
      if (cancelled || captured) return;
      const video = videoRef.current;
      // Sin frames todavía (cámara arrancando) — el interval reintenta.
      if (!video || video.videoWidth === 0) return;
      captured = true;
      const canvas = captureVideoFrame(video);
      if (!canvas) {
        setStep({ s: "manual", kind, reason: "face_error" });
        return;
      }
      canvasRef.current = canvas;
      canvas.toBlob(
        (b) => {
          photoRef.current = b;
        },
        "image/jpeg",
        0.8,
      );
      setStep({ s: "detecting", kind });
    };
    captureRef.current = doCapture;

    // countdown arranca null (el render muestra AUTO_CAPTURE_SECONDS de
    // fallback); el interval lo va bajando — setState solo en callbacks.
    const startedAt = Date.now();
    const timerId = setInterval(() => {
      const left =
        AUTO_CAPTURE_SECONDS - Math.floor((Date.now() - startedAt) / 1000);
      if (left <= 0) doCapture();
      else setCountdown(left);
    }, 250);

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      } catch {
        // Permiso negado / sin cámara → selector manual SIN foto.
        if (!cancelled) setStep({ s: "manual", kind, reason: "camera_denied" });
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(timerId);
      captureRef.current = () => {};
      setCountdown(null);
      stopCamera();
    };
  }, [step, stopCamera]);

  /* Match facial sobre el frame capturado (100% local — nada biométrico
     sale del dispositivo; solo la foto de evidencia sube al server). */
  useEffect(() => {
    if (step.s !== "detecting") return;
    const kind = step.kind;
    let cancelled = false;
    (async () => {
      const canvas = canvasRef.current;
      const withFace = (roster ?? []).filter(
        (e) => (e.faceDescriptors?.length ?? 0) > 0,
      );
      if (!canvas) {
        if (!cancelled) setStep({ s: "manual", kind, reason: "face_error" });
        return;
      }
      if (withFace.length === 0) {
        // Nadie enrolado: no vale la pena bajar los modelos.
        if (!cancelled) setStep({ s: "manual", kind, reason: "no_match" });
        return;
      }
      try {
        await loadFaceApi();
        if (cancelled) return;
        setModelsReady(true);
        // La promesa singleton ya resolvió: acá solo corre la detección.
        const descriptor = await detectFaceDescriptor(canvas);
        if (cancelled) return;
        if (!descriptor) {
          setStep({ s: "manual", kind, reason: "no_face" });
          return;
        }
        const match = bestMatch(descriptor, withFace);
        if (!match) {
          setStep({ s: "manual", kind, reason: "no_match" });
          return;
        }
        setStep({ s: "confirm", kind, emp: match.emp, distance: match.distance });
      } catch {
        if (!cancelled) setStep({ s: "manual", kind, reason: "face_error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, roster]);

  /* Punch: sube la foto (best-effort) y marca. confidence = 1 − distancia
     con match facial; null = selector manual. */
  const doPunch = useCallback(
    async (
      kind: Kind,
      emp: { id: string; name: string },
      confidence: number | null,
    ) => {
      if (punchingRef.current) return;
      punchingRef.current = true;
      setStep({ s: "saving", kind });
      let photoUrl: string | null = null;
      const blob = photoRef.current;
      if (blob) {
        try {
          const fd = new FormData();
          fd.append(
            "file",
            new File([blob], "punch.jpg", { type: "image/jpeg" }),
          );
          const r = await fetch("/api/operator/uploads", {
            method: "POST",
            body: fd,
          });
          if (r.ok) {
            const j = (await r.json()) as { url?: string };
            if (typeof j.url === "string") photoUrl = j.url;
          }
        } catch {
          // Falló la subida: se puncha igual sin foto — la asistencia manda.
        }
      }
      try {
        const clock = localPunchClock();
        const r = await fetch("/api/operator/attendance/punch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            employeeId: emp.id,
            kind,
            date: clock.date,
            nowMinutes: clock.nowMinutes,
            photoUrl,
            method: confidence !== null ? "face" : "manual",
            confidence,
          }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          setStep({
            s: "fail",
            msgKey: PUNCH_ERROR_KEYS[j.error ?? ""] ?? "errSaveFailed",
          });
          return;
        }
        const j = (await r.json()) as { action: Kind; implicit?: boolean };
        setStep({
          s: "done",
          kind: j.action,
          name: emp.name,
          time: formatDate(new Date(), {
            locale,
            dateStyle: undefined,
            timeStyle: "short",
            timeZone: DEVICE_TZ,
          }),
          implicit: j.implicit === true,
        });
      } catch {
        setStep({ s: "fail", msgKey: "errSaveFailed" });
      } finally {
        punchingRef.current = false;
        photoRef.current = null;
        canvasRef.current = null;
      }
    },
    [locale],
  );

  /* "Hola, {nombre}": auto-confirma a los 3 s (una sola vez). */
  useEffect(() => {
    if (step.s !== "confirm") return;
    const { kind, emp, distance } = step;
    let fired = false;
    // Igual que la captura: el render muestra CONFIRM_SECONDS de fallback
    // y el interval baja el contador.
    const startedAt = Date.now();
    const id = setInterval(() => {
      const left =
        CONFIRM_SECONDS - Math.floor((Date.now() - startedAt) / 1000);
      if (left <= 0) {
        if (!fired) {
          fired = true;
          void doPunch(kind, emp, confidenceFrom(distance));
        }
      } else {
        setCountdown(left);
      }
    }, 250);
    return () => {
      clearInterval(id);
      setCountdown(null);
    };
  }, [step, doPunch]);

  /* Éxito/error vuelven solos a la pantalla inicial. */
  useEffect(() => {
    if (step.s !== "done" && step.s !== "fail") return;
    const id = setTimeout(() => setStep({ s: "idle" }), RESULT_SECONDS * 1000);
    return () => clearTimeout(id);
  }, [step]);

  function startFlow(kind: Kind) {
    photoRef.current = null;
    canvasRef.current = null;
    setStep({ s: "camera", kind });
  }

  function cancelFlow() {
    setStep({ s: "idle" });
  }

  const kioskReady = roster !== null && roster.length > 0;

  /* ────────────────────────── Pantallas ──────────────────────────── */

  return (
    <div className="flex-1 w-full max-w-2xl mx-auto p-6 flex flex-col items-center justify-center text-center">
      {step.s === "idle" && (
        <div className="w-full space-y-8">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
              {t("kioskTitle")}
            </div>
            <div className="font-display text-6xl md:text-7xl tabular-nums mt-3">
              {now
                ? formatDate(now, {
                    locale,
                    dateStyle: undefined,
                    timeStyle: "medium",
                    timeZone: DEVICE_TZ,
                  })
                : "--:--:--"}
            </div>
            <div className="text-sm text-op-muted mt-2">
              {now
                ? formatDate(now, {
                    locale,
                    dateStyle: "full",
                    timeStyle: undefined,
                    timeZone: DEVICE_TZ,
                  })
                : " "}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => startFlow("in")}
              disabled={!kioskReady}
              className="min-h-[112px] rounded-3xl bg-ink text-bone font-display text-3xl hover:bg-ink/90 disabled:opacity-40"
            >
              {t("kioskCheckIn")}
            </button>
            <button
              type="button"
              onClick={() => startFlow("out")}
              disabled={!kioskReady}
              className="min-h-[112px] rounded-3xl border-2 border-ink bg-op-surface font-display text-3xl hover:bg-op-bg disabled:opacity-40"
            >
              {t("kioskCheckOut")}
            </button>
          </div>

          {rosterErr ? (
            <div className="space-y-3">
              <div className="text-xs text-danger">{t("errLoadFailed")}</div>
              <button
                type="button"
                onClick={() => {
                  setRosterErr(false);
                  setRosterSeq((s) => s + 1);
                }}
                className="min-h-[44px] px-5 rounded-full border border-op-border bg-op-surface text-sm font-medium hover:bg-op-bg"
              >
                {t("kioskRetry")}
              </button>
            </div>
          ) : roster === null ? (
            <div className="text-sm text-op-muted">{t("loading")}</div>
          ) : roster.length === 0 ? (
            <div className="text-sm text-op-muted">{t("kioskNoEmployees")}</div>
          ) : (
            <div className="text-sm text-op-muted">{t("kioskIdleHint")}</div>
          )}
        </div>
      )}

      {step.s === "camera" && (
        <div className="w-full max-w-md mx-auto space-y-4">
          <div className="relative w-full aspect-[3/4] rounded-3xl overflow-hidden bg-ink">
            {/* Preview espejado (selfie); la foto de evidencia se captura
                sin espejo (frame real de la cámara). */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="absolute inset-0 w-full h-full object-cover -scale-x-100"
            />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-56 h-56 md:w-64 md:h-64 rounded-full border-4 border-bone/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
            <div className="absolute bottom-4 inset-x-0 flex justify-center pointer-events-none">
              <div className="w-12 h-12 rounded-full bg-ink/70 text-bone font-display text-2xl flex items-center justify-center tabular-nums">
                {countdown ?? AUTO_CAPTURE_SECONDS}
              </div>
            </div>
          </div>
          <div className="text-sm text-op-muted">{t("kioskCameraHint")}</div>
          <div className="text-[11px] text-op-muted">{t("kioskPhotoNotice")}</div>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={cancelFlow}
              className="min-h-[56px] px-6 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={() => captureRef.current()}
              className="min-h-[56px] px-8 rounded-full bg-ink text-bone text-lg font-medium hover:bg-ink/90"
            >
              {t("kioskCapture")}
            </button>
          </div>
        </div>
      )}

      {step.s === "detecting" && (
        <div className="space-y-3">
          <div className="font-display text-2xl">
            {modelsReady ? t("kioskRecognizing") : t("kioskModelsLoading")}
          </div>
          <div className="text-sm text-op-muted animate-pulse">{"···"}</div>
        </div>
      )}

      {step.s === "confirm" && (
        <div className="w-full max-w-md mx-auto space-y-6">
          <div>
            <div className="font-display text-4xl md:text-5xl">
              {t("kioskHello", { name: step.emp.name })}
            </div>
            <div className="text-sm text-op-muted mt-2">{step.emp.position}</div>
          </div>
          <button
            type="button"
            onClick={() =>
              void doPunch(step.kind, step.emp, confidenceFrom(step.distance))
            }
            className="w-full min-h-[88px] rounded-3xl bg-ink text-bone font-display text-2xl hover:bg-ink/90"
          >
            {step.kind === "in" ? t("kioskConfirmIn") : t("kioskConfirmOut")}
          </button>
          <div className="text-xs text-op-muted tabular-nums">
            {t("kioskAutoConfirm", { seconds: countdown ?? CONFIRM_SECONDS })}
          </div>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() =>
                setStep({ s: "manual", kind: step.kind, reason: null })
              }
              className="min-h-[48px] px-5 rounded-full border border-op-border bg-op-surface text-sm font-medium hover:bg-op-bg"
            >
              {t("kioskNotMe")}
            </button>
            <button
              type="button"
              onClick={cancelFlow}
              className="min-h-[48px] px-5 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {step.s === "manual" && (
        <ManualPicker
          kind={step.kind}
          reason={step.reason}
          roster={roster ?? []}
          onPick={(emp) => void doPunch(step.kind, emp, null)}
          onCancel={cancelFlow}
        />
      )}

      {step.s === "saving" && (
        <div className="font-display text-2xl animate-pulse">{t("saving")}</div>
      )}

      {step.s === "done" && (
        <div className="space-y-4">
          <div className="w-20 h-20 mx-auto rounded-full bg-ok/10 text-[#1E5339] flex items-center justify-center font-display text-4xl">
            {"✓"}
          </div>
          <div className="font-display text-3xl md:text-4xl tabular-nums">
            {step.kind === "in"
              ? t("kioskSuccessIn", { name: step.name, time: step.time })
              : t("kioskSuccessOut", { name: step.name, time: step.time })}
          </div>
          {step.implicit && (
            <div className="text-sm text-op-muted">{t("kioskImplicitShift")}</div>
          )}
        </div>
      )}

      {step.s === "fail" && (
        <div className="space-y-4">
          <div className="w-20 h-20 mx-auto rounded-full bg-danger/10 text-danger flex items-center justify-center font-display text-4xl">
            {"✕"}
          </div>
          <div className="font-display text-2xl md:text-3xl">{t(step.msgKey)}</div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Selector manual ───────────────────────────── */

/**
 * Grid de nombres con búsqueda simple. Componente propio para que el
 * buscador nazca limpio en cada entrada al paso (estado local que se
 * desmonta con el paso — sin resets vía setState en efectos).
 */
function ManualPicker({
  kind,
  reason,
  roster,
  onPick,
  onCancel,
}: {
  kind: Kind;
  reason: ManualReason;
  roster: RosterEmployee[];
  onPick: (emp: RosterEmployee) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("opErp");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = norm(search.trim());
    if (!q) return roster;
    return roster.filter((e) => norm(e.name).includes(q));
  }, [roster, search]);

  return (
    <div className="w-full space-y-4">
      <div>
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {kind === "in" ? t("kioskCheckIn") : t("kioskCheckOut")}
        </div>
        <div className="font-display text-3xl mt-1">{t("kioskManualTitle")}</div>
      </div>
      {reason && (
        <div className="text-xs text-[#7F5A1F] bg-[#C98A2E]/10 rounded-xl px-4 py-2 inline-block">
          {t(MANUAL_NOTICE_KEYS[reason])}
        </div>
      )}
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("kioskSearchPlaceholder")}
        className="w-full min-h-[52px] px-4 rounded-2xl border border-op-border bg-op-bg text-base text-center focus:outline-none focus:border-op-text/40"
      />
      {filtered.length === 0 ? (
        <div className="text-sm text-op-muted py-6">{t("kioskNoResults")}</div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-[45dvh] overflow-y-auto">
          {filtered.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onPick(e)}
              className="min-h-[72px] px-3 py-2 rounded-2xl border border-op-border bg-op-surface hover:bg-op-bg text-center"
            >
              <div className="text-sm font-medium truncate">{e.name}</div>
              <div className="text-[11px] text-op-muted truncate mt-0.5">
                {e.position}
              </div>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onCancel}
        className="min-h-[48px] px-6 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
      >
        {t("cancel")}
      </button>
    </div>
  );
}
