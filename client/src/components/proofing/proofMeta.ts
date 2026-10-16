import type { PillTone } from "@/components/data";
import type { ApprovalChannel, JobOption, Proof, ProofCustomerRef, ProofFile, ProofJobRef, ProofSpecs, ProofStatus, SendChannel } from "@/lib/api/proofs";
import { daysUntil, fmtDate, fmtNumber } from "@/lib/format";

export const STATUS_META: Record<ProofStatus, { label: string; tone: PillTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  sent: { label: "Waiting", tone: "info" },
  revised: { label: "Waiting", tone: "info" },
  rejected: { label: "Changes requested", tone: "danger" },
  approved: { label: "Approved", tone: "success" },
  expired: { label: "Expired", tone: "neutral" }
};

export const isWaiting = (p: Pick<Proof, "status">) => p.status === "sent" || p.status === "revised";

export const SEND_CHANNELS: Record<SendChannel, string> = { whatsapp: "WhatsApp", email: "Email", in_person: "In person", other: "Other" };
export const APPROVAL_CHANNELS: Record<ApprovalChannel, string> = { whatsapp: "WhatsApp", phone: "Phone call", email: "Email", in_person: "In person", other: "Other" };

export const PAPER_SIZES = ["A4", "A3", "A5", "12 x 18 in", "13 x 19 in", "3.5 x 2 in (visiting card)", "DL envelope", "Custom"];
export const PAPER_TYPES = ["70 gsm maplitho", "100 gsm maplitho", "130 gsm art paper", "170 gsm art paper", "250 gsm art card", "300 gsm art card", "350 gsm art card", "Sticker (vinyl)", "Flex"];
export const FINISHING = ["Matt lamination", "Gloss lamination", "Spot UV", "Foil", "Die cut", "Embossing", "Folding", "Binding", "Perforation", "Numbering"];

/** Extensions the upload route accepts that make sense for proofs. */
export const PROOF_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "gif", "svg", "zip", "rar"];
export const PROOF_ACCEPT = PROOF_EXTENSIONS.map((e) => `.${e}`).join(",");
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const jobOf = (p: Proof): ProofJobRef | null => (p.jobId && typeof p.jobId === "object" ? p.jobId : null);
export const jobIdOf = (p: Proof): string => (typeof p.jobId === "string" ? p.jobId : p.jobId?._id || "");
export const jobTitleOf = (p: Proof) => jobOf(p)?.title || p.jobTitle || "Removed job";
export const customerOf = (p: Proof): ProofCustomerRef | null => (p.customerId && typeof p.customerId === "object" ? p.customerId : null);
export const jobCustomerName = (j: JobOption) => (j.customerId && typeof j.customerId === "object" ? j.customerId.name : j.customerName || "");
export const customerPhoneOf = (p: Proof) => customerOf(p)?.phone || p.customerPhone || "";

/** Indian numbers as "+91 98470 00000"; anything else is shown as typed. */
export function fmtPhone(raw?: string) {
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  const ten = d.length === 10 ? d : d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : "";
  return ten ? `+91 ${ten.slice(0, 5)} ${ten.slice(5)}` : raw;
}

/** Digits for a wa.me link (country code first), or "" when unusable. */
export function waNumber(raw?: string) {
  const d = (raw || "").replace(/\D/g, "");
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith("0")) return `91${d.slice(1)}`;
  if (d.length >= 11 && d.length <= 15) return d;
  return "";
}

export const fmtBytes = (n?: number) => {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};

const extOf = (name: string) => (name.split(".").pop() || "").toLowerCase();

export type FileKind = "image" | "pdf" | "other";
export function fileKind(f: Pick<ProofFile, "fileName" | "mimeType" | "fileType">): FileKind {
  const ext = (f.fileType || "").replace(".", "").toLowerCase() || extOf(f.fileName);
  if ((f.mimeType || "").startsWith("image/") || ["jpg", "jpeg", "png", "gif", "svg", "webp"].includes(ext)) return "image";
  if (f.mimeType === "application/pdf" || ext === "pdf") return "pdf";
  return "other";
}
export const fileExt = (f: Pick<ProofFile, "fileName" | "fileType">) => ((f.fileType || "").replace(".", "") || extOf(f.fileName)).toUpperCase();

/** Problems with a file the person picked, before it is uploaded. */
export function fileProblem(file: File) {
  if (!PROOF_EXTENSIONS.includes(extOf(file.name))) return `${file.name}: use PDF, JPG, PNG, GIF, SVG, ZIP or RAR`;
  if (file.size > MAX_FILE_BYTES) return `${file.name} is larger than 50 MB`;
  if (file.size === 0) return `${file.name} is empty`;
  return null;
}

export const colourLabel = (c?: string) => (c === "black_white" ? "Black & white" : "Colour");

/** "A4 · 300 gsm art card · Colour · 1,000 pcs · Matt lamination" */
export function specLine(s?: ProofSpecs) {
  if (!s) return "";
  return [s.paperSize, s.paperType, s.colorMode ? colourLabel(s.colorMode) : "", s.quantity ? `${fmtNumber(s.quantity)} pcs` : "", ...(s.finishing || [])]
    .filter(Boolean)
    .join(" · ");
}

/** The most recent thing that happened, for the list's date column. */
export function lastEvent(p: Proof): { label: string; date?: string } {
  if (p.status === "approved") return { label: "Approved", date: p.approval?.approvedAt || p.updatedAt };
  if (p.status === "rejected") return { label: "Changes asked", date: p.approval?.rejectedAt || p.updatedAt };
  if (isWaiting(p)) return { label: p.version > 1 ? `Sent v${p.version}` : "Sent", date: p.notifications?.sentAt || p.updatedAt };
  return { label: "Updated", date: p.updatedAt };
}

/** "Reply by 20 Oct", "Reply due today", "Reply 2 days overdue" for waiting proofs. */
export function replyDue(p: Proof): { text: string; overdue: boolean } | null {
  if (!isWaiting(p) || !p.approval?.expiresAt) return null;
  const n = daysUntil(p.approval.expiresAt);
  if (n === null) return null;
  if (p.isOverdue || n < 0) return { text: n >= 0 ? "Reply overdue" : `Reply ${-n} day${n === -1 ? "" : "s"} overdue`, overdue: true };
  if (n === 0) return { text: "Reply due today", overdue: false };
  if (n === 1) return { text: "Reply due tomorrow", overdue: false };
  return { text: `Reply by ${fmtDate(p.approval.expiresAt)}`, overdue: false };
}

/** The message a person sends the customer with the proof (WhatsApp or copied). */
export function proofMessage(p: Proof, company?: string) {
  const files = p.files?.length || 0;
  const specs = specLine(p.specifications);
  const lines: (string | null)[] = [
    `Hello ${p.customerName},`,
    "",
    p.version > 1 ? `The corrected proof (version ${p.version}) is ready for your approval.` : "Your proof is ready for your approval.",
    "",
    `Proof: ${p.proofNumber}${p.version > 1 ? ` (version ${p.version})` : ""}`,
    `Job: ${jobTitleOf(p)}`,
    `Item: ${p.title}`,
    specs ? `Specs: ${specs}` : null,
    p.version > 1 && p.versionNotes ? `What changed: ${p.versionNotes}` : null,
    "",
    files ? `${files === 1 ? "The proof file is" : `The ${files} proof files are`} shared with this message.` : null,
    'Please check the text, spelling, colours and layout carefully. Reply "Approved" to go ahead with printing, or tell us what to change.',
    "",
    "Thank you,",
    company || null
  ];
  return lines
    .filter((l): l is string => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const waLink = (phone: string, text: string) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;

export type ProofAction = "send" | "share" | "approve" | "reject" | "version" | "edit" | "delete";

export interface ProofPermissions {
  canWrite: boolean;
  canApprove: boolean;
  canReject: boolean;
}

/** Which actions a proof offers in its current state, for this login. */
export function availableActions(p: Proof, perms: ProofPermissions) {
  const waiting = isWaiting(p);
  return {
    send: perms.canWrite && (p.status === "draft" || p.status === "expired"),
    share: perms.canWrite && waiting,
    approve: perms.canApprove && p.status !== "approved",
    reject: perms.canReject && p.status !== "rejected" && p.status !== "draft",
    version: perms.canWrite,
    edit: perms.canWrite,
    delete: perms.canWrite
  };
}
