"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export function BackToListLink({ href, className, children }: {
  href: string;
  className: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <Link href={href} className={className} onNavigate={event => {
      if (history.state?.mpScrollFrom === href) {
        event.preventDefault();
        router.back();
      }
    }}>
      {children}
    </Link>
  );
}
