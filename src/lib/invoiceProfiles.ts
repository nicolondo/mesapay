/**
 * Per-device storage for the diner's invoice billing info.
 *
 * Stored in localStorage under a single key so that any restaurant on the
 * mesapay.co domain can offer "fill with saved data" without the diner
 * having to retype name + NIT + address. Nothing leaves the device — we
 * never sync this server-side. If the user clears their browser data
 * they lose the profiles, which is the expected behaviour for
 * privacy-by-default storage.
 */

import { z } from "zod";

const KEY = "mesapay.invoiceProfiles";
const MAX_PROFILES = 5;

const DocType = z.enum(["CC", "CE", "NIT", "PA"]);

const ProfileSchema = z.object({
  // Local id used only for React keys + remove operations. Not sent anywhere.
  id: z.string().min(1),
  customerName: z.string().min(2).max(160),
  docType: DocType,
  docNumber: z.string().min(4).max(40),
  email: z.string().email(),
  address: z.string().min(4).max(240),
  city: z.string().min(2).max(80),
  department: z.string().min(2).max(80),
  placeId: z.string().nullable().optional(),
  rawComponents: z.unknown().optional(),
  // Used to sort recent-first.
  lastUsedAt: z.number(),
});

export type InvoiceProfile = z.infer<typeof ProfileSchema>;

const StorageSchema = z.object({
  version: z.literal(1),
  profiles: z.array(ProfileSchema),
});

export function loadProfiles(): InvoiceProfile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = StorageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return parsed.data.profiles.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch {
    return [];
  }
}

/**
 * Save/upsert a profile. Dedupes on (docType, docNumber) so the same
 * person/company doesn't accumulate stale entries each time they change
 * a small field. Caps the list to MAX_PROFILES, evicting least-recently-used.
 */
export function saveProfile(
  profile: Omit<InvoiceProfile, "id" | "lastUsedAt"> & {
    id?: string;
  },
): InvoiceProfile {
  const profiles = loadProfiles();
  const now = Date.now();
  const matchKey = (p: InvoiceProfile) =>
    p.docType === profile.docType &&
    p.docNumber.trim() === profile.docNumber.trim();
  const existing = profiles.find(matchKey);
  const next: InvoiceProfile = {
    id: existing?.id ?? profile.id ?? cryptoId(),
    customerName: profile.customerName,
    docType: profile.docType,
    docNumber: profile.docNumber,
    email: profile.email,
    address: profile.address,
    city: profile.city,
    department: profile.department,
    placeId: profile.placeId ?? null,
    rawComponents: profile.rawComponents,
    lastUsedAt: now,
  };
  const filtered = profiles.filter((p) => !matchKey(p));
  const updated = [next, ...filtered]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_PROFILES);
  persist(updated);
  return next;
}

export function removeProfile(id: string): void {
  const profiles = loadProfiles().filter((p) => p.id !== id);
  persist(profiles);
}

export function touchProfile(id: string): void {
  const profiles = loadProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) return;
  profiles[idx] = { ...profiles[idx], lastUsedAt: Date.now() };
  persist(profiles);
}

export function clearProfiles(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

function persist(profiles: InvoiceProfile[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, profiles }),
    );
  } catch {
    /* quota / private mode — silently drop, the form still works without it */
  }
}

function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "p_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
