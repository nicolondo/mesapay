"use client";

import { useEffect, useRef, useState } from "react";

export function StatCountUp({
  value,
  suffix = "",
  prefix = "",
  durationMs = 1400,
  format = "int",
}: {
  value: number;
  suffix?: string;
  prefix?: string;
  durationMs?: number;
  format?: "int" | "decimal";
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [display, setDisplay] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setDisplay(value);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || started.current) return;
        started.current = true;
        const t0 = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - t0) / durationMs);
          const eased = 1 - Math.pow(1 - t, 3);
          setDisplay(value * eased);
          if (t < 1) requestAnimationFrame(tick);
          else setDisplay(value);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [value, durationMs]);

  const formatted =
    format === "int"
      ? Math.round(display).toString()
      : (Math.round(display * 10) / 10).toFixed(1);

  return (
    <span ref={ref} className="tabular">
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}
