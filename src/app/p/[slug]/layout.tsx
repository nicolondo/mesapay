import type { Metadata } from "next";

// Pickup diners browse and pay on the web, just like diners at a table.
export const metadata: Metadata = {
  manifest: null,
  appleWebApp: { capable: false },
};

export default function PickupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
