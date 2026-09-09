import { randomBytes } from "node:crypto";

/** 96 random bits; uniqueness is additionally enforced by PostgreSQL. */
export function shortCode(): string {
  return randomBytes(12).toString("hex").toUpperCase().match(/.{1,6}/g)!.join("-");
}
