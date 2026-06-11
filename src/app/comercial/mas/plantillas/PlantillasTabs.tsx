"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { TemplatesClient } from "./TemplatesClient";
import { WhatsappTemplatesClient } from "./WhatsappTemplatesClient";

type DocOption = { id: string; name: string; scope: string };

type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  attachmentIds: string[];
  scope: string;
  ownerUserId: string | null;
};

type WaTemplate = {
  id: string;
  name: string;
  body: string;
  scope: string;
  ownerUserId: string | null;
};

export function PlantillasTabs({
  emailTemplates,
  waTemplates,
  docs,
  userId,
  isAdmin,
}: {
  emailTemplates: EmailTemplate[];
  waTemplates: WaTemplate[];
  docs: DocOption[];
  userId: string;
  isAdmin: boolean;
}) {
  const t = useTranslations("crm");
  const [tab, setTab] = useState<"email" | "whatsapp">("email");

  const tabClass = (active: boolean) =>
    "flex-1 py-2.5 rounded-xl text-sm font-medium min-h-[44px] transition-colors " +
    (active
      ? "bg-terracotta text-white"
      : "border border-op-border text-op-muted hover:text-op-text bg-op-surface");

  return (
    <div className="flex-1 p-4 max-w-2xl mx-auto w-full space-y-4">
      <div className="font-display text-2xl tracking-[-0.015em]">
        {t("templatesPageTitleAll")}
      </div>
      <div className="flex gap-2">
        <button onClick={() => setTab("email")} className={tabClass(tab === "email")}>
          {t("templatesTabEmail")}
        </button>
        <button onClick={() => setTab("whatsapp")} className={tabClass(tab === "whatsapp")}>
          {t("templatesTabWhatsapp")}
        </button>
      </div>
      {tab === "email" ? (
        <TemplatesClient initial={emailTemplates} docs={docs} userId={userId} isAdmin={isAdmin} />
      ) : (
        <WhatsappTemplatesClient initial={waTemplates} userId={userId} isAdmin={isAdmin} />
      )}
    </div>
  );
}
