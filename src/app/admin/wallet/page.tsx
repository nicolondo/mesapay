import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { WalletClient } from "./WalletClient";

export const dynamic = "force-dynamic";
export default async function PlatformWalletPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/admin/wallet");
  if (session.user.role !== "platform_admin") redirect("/");
  return <WalletClient />;
}
