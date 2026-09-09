"use client";
import { useEffect, useState } from "react";

/** Initial value comes from the server so hydration and the first render agree. */
export function useClock(initialTime: number) {
  const [now, setNow] = useState(initialTime);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
