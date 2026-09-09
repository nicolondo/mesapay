import { z } from "zod";

export const amountCentsSchema = z.number().int().min(100).max(2_000_000_000);
export const tipCentsSchema = z.number().int().min(0).max(2_000_000_000).default(0);
export const validPaymentAmounts = (p: { amountCents: number; tipCents: number }) => p.tipCents <= p.amountCents;
export function demoPaymentsAllowed() {
  return process.env.NODE_ENV !== "production" && process.env.KUSHKI_MODE === "mock";
}
