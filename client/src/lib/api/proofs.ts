// Proofing & approvals: typed calls to /api/proofs, plus the file upload and
// authenticated download the proof files need.
import apiClient, { BASE_URL } from "@/lib/apiClient";

export type ProofStatus = "draft" | "sent" | "approved" | "rejected" | "revised" | "expired";
export type ProofView = "all" | "draft" | "waiting" | "overdue" | "rejected" | "approved";
export type SendChannel = "whatsapp" | "email" | "in_person" | "other";
export type ApprovalChannel = "whatsapp" | "email" | "phone" | "in_person" | "other";
export type ColorMode = "color" | "black_white";

export interface ProofFile {
  _id?: string;
  fileId?: string;
  fileName: string;
  fileUrl: string;
  fileType: string;
  fileSize: number;
  mimeType?: string;
  uploadedAt?: string;
}

export interface ProofVersion {
  _id?: string;
  version: number;
  files?: ProofFile[];
  uploadedAt?: string;
  notes?: string;
  status?: ProofStatus;
  sentAt?: string;
  rejectionReason?: string;
  rejectedAt?: string;
}

export interface ProofComment {
  _id: string;
  comment: string;
  commentedByName?: string;
  commentedAt: string;
  isInternal?: boolean;
}

export interface ProofSpecs {
  paperSize?: string;
  paperType?: string;
  colorMode?: ColorMode;
  quantity?: number;
  finishing?: string[];
  specialInstructions?: string;
}

export interface ProofJobRef {
  _id: string;
  title: string;
  status?: string;
  dueDate?: string;
}

export interface ProofCustomerRef {
  _id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
}

export interface Proof {
  _id: string;
  proofNumber: string;
  jobId: ProofJobRef | string | null;
  jobTitle?: string;
  customerId: ProofCustomerRef | string | null;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  title: string;
  description?: string;
  files: ProofFile[];
  specifications?: ProofSpecs;
  status: ProofStatus;
  version: number;
  versionNotes?: string;
  previousVersions?: ProofVersion[];
  approval?: {
    status?: "pending" | "approved" | "rejected" | "expired";
    approvedByName?: string;
    channel?: ApprovalChannel;
    recordedByName?: string;
    approvedAt?: string;
    rejectedAt?: string;
    rejectionReason?: string;
    approvalNotes?: string;
    expiresAt?: string;
  };
  feedback?: { comments?: ProofComment[] };
  notifications?: { sentAt?: string; sentByName?: string; sentVia?: SendChannel; reminderSentAt?: string };
  settings?: { expiryDays?: number };
  isOverdue?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProofSummary {
  all: number;
  draft: number;
  waiting: number;
  overdue: number;
  rejected: number;
  approved: number;
}

export interface ProofStats extends ProofSummary {
  total: number;
  approvedThisMonth: number;
}

export interface ProofListResponse {
  proofs: Proof[];
  summary: ProofSummary;
  pagination: { current: number; total: number; count: number; totalProofs: number };
}

export interface ProofInput {
  jobId: string;
  title: string;
  description?: string;
  specifications?: ProofSpecs;
}

export interface ProofCreateInput extends ProofInput {
  files: { fileId: string }[];
  status: "draft" | "sent";
  sentVia?: SendChannel;
}

/** A file stored by POST /api/files/upload. */
export interface UploadedFile {
  _id: string;
  originalName: string;
  fileUrl: string;
  fileType: string;
  fileSize: number;
  mimeType: string;
}

export interface JobOption {
  _id: string;
  title: string;
  status?: string;
  dueDate?: string;
  customerId?: ProofCustomerRef | string | null;
  customerName?: string;
  printSpecs?: { paperType?: string; colorType?: ColorMode; printSize?: string; quantity?: number; lamination?: string; binding?: string };
}

type One = { proof: Proof };

export const proofsApi = {
  list: (params: { view?: ProofView; search?: string; page?: number; limit?: number; jobId?: string }) =>
    apiClient.get<ProofListResponse>("/proofs", params),
  stats: () => apiClient.get<{ stats: ProofStats }>("/proofs/stats/summary").then((r) => r.stats),
  get: (id: string) => apiClient.get<One>(`/proofs/${id}`).then((r) => r.proof),
  create: (input: ProofCreateInput) => apiClient.post<One>("/proofs", input).then((r) => r.proof),
  update: (id: string, input: Partial<ProofInput>) => apiClient.put<One>(`/proofs/${id}`, input).then((r) => r.proof),
  remove: (id: string) => apiClient.delete<unknown>(`/proofs/${id}`),
  send: (id: string, sentVia?: SendChannel) => apiClient.post<One>(`/proofs/${id}/send`, { sentVia }).then((r) => r.proof),
  approve: (id: string, input: { approvedByName?: string; channel?: ApprovalChannel; approvalNotes?: string }) =>
    apiClient.put<One>(`/proofs/${id}/approve`, input).then((r) => r.proof),
  reject: (id: string, rejectionReason: string) => apiClient.put<One>(`/proofs/${id}/reject`, { rejectionReason }).then((r) => r.proof),
  newVersion: (id: string, input: { files: { fileId: string }[]; notes?: string; send: boolean; sentVia?: SendChannel }) =>
    apiClient.post<One>(`/proofs/${id}/versions`, input).then((r) => r.proof),
  comment: (id: string, comment: string) => apiClient.post<One>(`/proofs/${id}/comments`, { comment }).then((r) => r.proof),
  jobs: () => apiClient.listAll<JobOption>("/jobs", "jobs")
};

const authHeader = (): Record<string, string> => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const errorFrom = async (res: Response, fallback: string) => {
  try {
    const body = (await res.json()) as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(res.status === 413 ? "The file is too large." : fallback);
  }
};

/** Upload one proof file (multipart), linked to the job it belongs to. */
export async function uploadProofFile(file: File, job: { _id: string; title: string }): Promise<UploadedFile> {
  const form = new FormData();
  form.append("file", file);
  form.append("category", "proof");
  form.append("entityType", "job");
  form.append("entityId", job._id);
  form.append("entityName", job.title);
  const res = await fetch(`${BASE_URL}/files/upload`, { method: "POST", headers: authHeader(), body: form });
  if (!res.ok) throw await errorFrom(res, `${file.name} could not be uploaded`);
  const body = (await res.json()) as { data?: { file?: UploadedFile } };
  if (!body.data?.file?._id) throw new Error(`${file.name} could not be uploaded`);
  return body.data.file;
}

/**
 * Upload several files one after another. Files already uploaded in an earlier
 * attempt (kept in `done`) are not sent again when a save is retried.
 */
export async function uploadProofFiles(
  files: File[],
  job: { _id: string; title: string },
  onProgress?: (current: number, total: number) => void,
  done?: WeakMap<File, UploadedFile>
): Promise<UploadedFile[]> {
  const out: UploadedFile[] = [];
  for (let i = 0; i < files.length; i++) {
    onProgress?.(i + 1, files.length);
    const f = files[i];
    const uploaded = done?.get(f) || (await uploadProofFile(f, job));
    done?.set(f, uploaded);
    out.push(uploaded);
  }
  return out;
}

// Files are only served through the authenticated download route, so they are
// fetched as blobs. Previews reuse the same blob for the session.
const blobCache = new Map<string, Promise<Blob>>();

/** A proof file as a blob. Previews (`view`) are not counted as downloads on the server. */
export function fetchProofFile(fileId: string, view = true): Promise<Blob> {
  const key = `${fileId}:${view ? "view" : "download"}`;
  const cached = blobCache.get(key);
  if (cached) return cached;
  const p = fetch(`${BASE_URL}/files/${fileId}/download${view ? "?view=1" : ""}`, { headers: authHeader() }).then(async (res) => {
    if (!res.ok) throw await errorFrom(res, "The file could not be opened");
    return res.blob();
  });
  blobCache.set(key, p);
  p.catch(() => blobCache.delete(key));
  return p;
}

/** Save a proof file to the computer under its original name. */
export async function downloadProofFile(file: ProofFile) {
  if (!file.fileId) throw new Error("This file was saved before downloads were available.");
  const blob = await fetchProofFile(file.fileId, false);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Open a proof file in a new tab (PDFs and images open in the browser's viewer). */
export async function openProofFile(file: ProofFile) {
  if (!file.fileId) throw new Error("This file was saved before downloads were available.");
  // Only PDFs and plain images open in a tab. Anything else (SVG, HTML, office
  // files…) is saved instead, so a file can never run script on this site.
  if (!/\.(pdf|png|jpe?g|gif|webp)$/i.test(file.fileName)) return downloadProofFile(file);
  // Open the tab now, while the click still counts, then point it at the file.
  const tab = window.open("", "_blank");
  if (!tab) return downloadProofFile(file); // pop-ups blocked: save it instead
  try {
    const blob = await fetchProofFile(file.fileId);
    const url = URL.createObjectURL(blob);
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    tab.close();
    throw error;
  }
}
