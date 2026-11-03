import type { MetricTone, PillTone } from "@/components/data";

export interface MetaTemplate {
  id?: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: any[];
}

/** One of the ERP's own templates, ready to submit (see GET /whatsapp/starter-templates). */
export interface StarterTemplate {
  name: string;
  language: string;
  category: string;
  purpose: string;
  components: any[];
}

/** The connected number as Meta reports it (GET /whatsapp/account). */
export interface WhatsAppAccount {
  displayPhoneNumber?: string;
  verifiedName?: string;
  qualityRating?: string;
  messagingLimitTier?: string;
  nameStatus?: string;
  codeVerificationStatus?: string;
}

export interface WhatsAppConfig {
  enabled: boolean;
  wabaId: string;
  phoneNumberId: string;
  setupMethod: string;
  hasAccessToken: boolean;
  connectedAt?: string;
  webhookSubscribed: boolean;
}

export type StatusGroup = "approved" | "review" | "attention" | "other";

export const STATUS_META: Record<string, { label: string; tone: PillTone; group: StatusGroup }> = {
  APPROVED: { label: "Approved", tone: "success", group: "approved" },
  PENDING: { label: "In review", tone: "warning", group: "review" },
  IN_APPEAL: { label: "In appeal", tone: "warning", group: "review" },
  REJECTED: { label: "Rejected", tone: "danger", group: "attention" },
  PAUSED: { label: "Paused", tone: "danger", group: "attention" },
  DISABLED: { label: "Disabled", tone: "danger", group: "attention" },
  PENDING_DELETION: { label: "Being deleted", tone: "neutral", group: "other" }
};

export const statusMeta = (status: string) =>
  STATUS_META[status] || { label: status ? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ") : "Unknown", tone: "neutral" as PillTone, group: "other" as StatusGroup };

/** What each status means for the person reading it, shown in the template preview. */
export const STATUS_HELP: Record<StatusGroup, string> = {
  approved: "Ready to send from invoices, quotations and payment reminders.",
  review: "Meta is reviewing this template. It can be sent once approved, usually within 24 hours.",
  attention: "Meta won't deliver this template. Open WhatsApp Manager to see why, then edit it there or create a new one.",
  other: "This template can't be sent right now."
};

export const CATEGORY_LABEL: Record<string, string> = {
  UTILITY: "Utility",
  MARKETING: "Marketing",
  AUTHENTICATION: "Authentication"
};

export const QUALITY_META: Record<string, { label: string; tone: MetricTone }> = {
  GREEN: { label: "High", tone: "success" },
  YELLOW: { label: "Medium", tone: "warning" },
  RED: { label: "Low", tone: "danger" }
};

export const LIMIT_LABEL: Record<string, string> = {
  TIER_50: "50",
  TIER_250: "250",
  TIER_1K: "1,000",
  TIER_10K: "10,000",
  TIER_100K: "1,00,000",
  TIER_UNLIMITED: "Unlimited"
};

/** "Up to 1,000 new customers a day" for Meta's messaging-limit tier. */
export const limitHint = (tier?: string) => {
  const n = tier && LIMIT_LABEL[tier];
  if (!n) return "Limit not reported";
  return n === "Unlimited" ? "No daily customer limit" : `Up to ${n} customers a day`;
};

export const whatsappManagerUrl = (wabaId: string, page: "home" | "message-templates" = "home") =>
  `https://business.facebook.com/wa/manage/${page}/?waba_id=${encodeURIComponent(wabaId)}`;
