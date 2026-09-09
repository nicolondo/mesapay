"use client";
import { useSyncExternalStore } from "react";

const subscribe = (changed: () => void) => {
  window.addEventListener("focus", changed);
  window.addEventListener("pageshow", changed);
  return () => {
    window.removeEventListener("focus", changed);
    window.removeEventListener("pageshow", changed);
  };
};
const serverUnsupported = () => false;
function applePaySupported() {
  try {
    return !!(window as unknown as { ApplePaySession?: { canMakePayments?: () => boolean } }).ApplePaySession?.canMakePayments?.();
  } catch { return false; }
}
function pushSupported() {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}
export function useApplePaySupport() {
  return useSyncExternalStore(subscribe, applePaySupported, serverUnsupported);
}
export function usePushSupport() {
  return useSyncExternalStore(subscribe, pushSupported, serverUnsupported);
}
