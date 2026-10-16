import { useEffect, useState } from "react";
import { CheckCircle2, Clock, FilePen, History, Loader2, MessageSquareWarning, MoreHorizontal, Pencil, Send, Share2, StickyNote, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusPill, Tag } from "@/components/data";
import { useToast } from "@/hooks/use-toast";
import { proofsApi, type Proof } from "@/lib/api/proofs";
import { fmtDate, fmtRelative, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ProofFileChips, ProofFiles } from "./ProofFiles";
import { APPROVAL_CHANNELS, SEND_CHANNELS, STATUS_META, availableActions, colourLabel, customerOf, customerPhoneOf, fmtPhone, isWaiting, jobOf, jobTitleOf, replyDue, type ProofAction, type ProofPermissions } from "./proofMeta";

function Section({ title, icon: Icon, children, aside }: { title: string; icon?: React.ComponentType<{ className?: string }>; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children || "—"}</dd>
    </div>
  );
}

/** The state of the proof in one sentence or two, coloured by outcome. */
function StatusCallout({ p }: { p: Proof }) {
  const a = p.approval || {};
  if (p.status === "approved") {
    return (
      <div className="rounded-lg bg-success-soft px-4 py-3 text-sm text-success-strong">
        <div className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Approved on {fmtDate(a.approvedAt)}
        </div>
        <p className="mt-1">
          {[a.approvedByName ? `By ${a.approvedByName}` : `By ${p.customerName}`, a.channel ? `via ${APPROVAL_CHANNELS[a.channel]}` : "", a.recordedByName ? `· recorded by ${a.recordedByName}` : ""].filter(Boolean).join(" ")}
        </p>
        {a.approvalNotes && <p className="mt-1 whitespace-pre-wrap text-foreground/80">{a.approvalNotes}</p>}
      </div>
    );
  }
  if (p.status === "rejected") {
    return (
      <div className="rounded-lg bg-destructive-soft px-4 py-3 text-sm text-destructive-strong">
        <div className="flex items-center gap-2 font-medium">
          <MessageSquareWarning className="h-4 w-4" />
          Changes requested on {fmtDate(a.rejectedAt)}
        </div>
        {a.rejectionReason && <p className="mt-1 whitespace-pre-wrap text-foreground/90">{a.rejectionReason}</p>}
        <p className="mt-1 text-xs">Upload a new version once the artwork is corrected.</p>
      </div>
    );
  }
  if (isWaiting(p)) {
    const due = replyDue(p);
    const n = p.notifications || {};
    return (
      <div className={cn("rounded-lg px-4 py-3 text-sm", due?.overdue ? "bg-warning-soft text-warning-strong" : "bg-info-soft text-info-strong")}>
        <div className="flex items-center gap-2 font-medium">
          <Clock className="h-4 w-4" />
          Waiting for {p.customerName}
          {due ? ` · ${due.text}` : ""}
        </div>
        <p className="mt-1 text-foreground/80">
          Sent {fmtDate(n.sentAt)}
          {n.sentVia ? ` by ${SEND_CHANNELS[n.sentVia]}` : ""}
          {n.sentByName ? ` · ${n.sentByName}` : ""}
          {n.reminderSentAt ? ` · reminded ${fmtDate(n.reminderSentAt)}` : ""}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <FilePen className="h-4 w-4" />
        Not sent yet
      </div>
      <p className="mt-1">Send it to the customer when the artwork is ready.</p>
    </div>
  );
}

/**
 * One proof: the artwork, what the customer said, the earlier versions and
 * the team's notes, with the next step at the top.
 */
export function ProofDetailSheet({
  proof,
  loading,
  open,
  onOpenChange,
  perms,
  onAction,
  onChanged
}: {
  proof: Proof | null;
  /** The full record is still loading (history and notes). */
  loading?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  perms: ProofPermissions;
  onAction: (action: ProofAction, proof: Proof) => void;
  onChanged: (proof: Proof) => void;
}) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    setNote("");
  }, [proof?._id]);

  const addNote = async () => {
    if (!proof || !note.trim()) return;
    setSavingNote(true);
    try {
      const updated = await proofsApi.comment(proof._id, note.trim());
      setNote("");
      onChanged(updated);
    } catch (error) {
      toast({ title: "Note not added", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSavingNote(false);
    }
  };

  const p = proof;
  const can = p ? availableActions(p, perms) : null;
  const status = p ? STATUS_META[p.status] : null;
  const due = p ? replyDue(p) : null;
  const specs = p?.specifications;
  const customer = p ? customerOf(p) : null;
  const job = p ? jobOf(p) : null;
  const history = [...(p?.previousVersions || [])].sort((x, y) => y.version - x.version);
  const comments = [...(p?.feedback?.comments || [])].sort((x, y) => +new Date(y.commentedAt) - +new Date(x.commentedAt));

  const primary = (() => {
    if (!p || !can) return null;
    if (can.send) return { label: "Send to customer", icon: Send, action: "send" as const };
    if (isWaiting(p) && can.approve) return { label: "Record approval", icon: CheckCircle2, action: "approve" as const };
    if (p.status === "rejected" && can.version) return { label: "Upload new version", icon: Upload, action: "version" as const };
    return null;
  })();

  const secondary: { label: string; icon: React.ComponentType<{ className?: string }>; action: ProofAction }[] = [];
  if (p && can) {
    if (isWaiting(p) && can.reject) secondary.push({ label: "Changes requested", icon: MessageSquareWarning, action: "reject" });
    if (can.share) secondary.push({ label: "Share again", icon: Share2, action: "share" });
    if (p.status === "draft" && can.approve) secondary.push({ label: "Record approval", icon: CheckCircle2, action: "approve" });
  }

  const menu: { label: string; icon: React.ComponentType<{ className?: string }>; action: ProofAction; destructive?: boolean; show: boolean }[] = p && can
    ? [
        { label: "Edit details", icon: Pencil, action: "edit", show: can.edit },
        { label: "Upload new version", icon: Upload, action: "version", show: can.version && primary?.action !== "version" },
        { label: "Record approval", icon: CheckCircle2, action: "approve", show: can.approve && p.status === "rejected" },
        { label: "Changes requested", icon: MessageSquareWarning, action: "reject", show: can.reject && p.status === "approved" },
        { label: "Delete proof", icon: Trash2, action: "delete", destructive: true, show: can.delete }
      ]
    : [];
  const shownMenu = menu.filter((m) => m.show);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        {p && status ? (
          <>
            <SheetHeader className="space-y-1 border-b px-5 py-4 pr-12 text-left">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono text-[13px] text-foreground">{p.proofNumber}</span>
                <Tag>v{p.version}</Tag>
                <StatusPill tone={due?.overdue ? "warning" : status.tone}>{due?.overdue ? "Overdue" : status.label}</StatusPill>
              </div>
              <SheetTitle className="break-words text-lg">{p.title}</SheetTitle>
              <SheetDescription>
                {jobTitleOf(p)} · {p.customerName}
              </SheetDescription>
            </SheetHeader>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
              {(primary || secondary.length > 0 || shownMenu.length > 0) && (
                <div className="flex flex-wrap items-center gap-2">
                  {primary && (
                    <Button onClick={() => onAction(primary.action, p)}>
                      <primary.icon />
                      {primary.label}
                    </Button>
                  )}
                  {secondary.map((s) => (
                    <Button key={s.action} variant="outline" onClick={() => onAction(s.action, p)}>
                      <s.icon />
                      {s.label}
                    </Button>
                  ))}
                  {shownMenu.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon" aria-label="More actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        {shownMenu.map((m, i) => (
                          <div key={m.label}>
                            {m.destructive && i > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuItem onClick={() => onAction(m.action, p)} className={cn(m.destructive && "text-destructive-strong focus:text-destructive-strong")}>
                              <m.icon />
                              {m.label}
                            </DropdownMenuItem>
                          </div>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              )}

              <StatusCallout p={p} />

              <Section title={`Version ${p.version} files`} aside={<span className="text-xs text-muted-foreground">Uploaded {fmtDate(p.files[0]?.uploadedAt || p.createdAt)}</span>}>
                {p.versionNotes && (
                  <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">What changed: </span>
                    {p.versionNotes}
                  </p>
                )}
                <ProofFiles files={p.files} />
              </Section>

              <Section title="Details">
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  <Field label="Customer">
                    <span className="font-medium">{p.customerName}</span>
                    {customerPhoneOf(p) && <span className="block text-muted-foreground">{fmtPhone(customerPhoneOf(p))}</span>}
                    {(customer?.email || p.customerEmail) && <span className="block truncate text-muted-foreground">{customer?.email || p.customerEmail}</span>}
                  </Field>
                  <Field label="Job">
                    <span className="font-medium">{jobTitleOf(p)}</span>
                    {job?.status && <span className="block text-muted-foreground">{humanize(job.status)}{job.dueDate ? ` · due ${fmtDate(job.dueDate)}` : ""}</span>}
                  </Field>
                  <Field label="Paper size">{specs?.paperSize}</Field>
                  <Field label="Paper type">{specs?.paperType}</Field>
                  <Field label="Colour">{specs?.colorMode ? colourLabel(specs.colorMode) : ""}</Field>
                  <Field label="Quantity">{specs?.quantity ? specs.quantity.toLocaleString("en-IN") : ""}</Field>
                  <Field label="Finishing">{specs?.finishing?.length ? specs.finishing.join(", ") : ""}</Field>
                  <Field label="Created">{fmtDate(p.createdAt)}</Field>
                </dl>
                {specs?.specialInstructions && <Field label="Instructions">{<span className="whitespace-pre-wrap">{specs.specialInstructions}</span>}</Field>}
                {p.description && <Field label="Description">{<span className="whitespace-pre-wrap">{p.description}</span>}</Field>}
              </Section>

              <Section title="Version history" icon={History}>
                {loading ? (
                  <div className="h-10 animate-pulse rounded-md bg-muted" />
                ) : history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">This is the first version.</p>
                ) : (
                  <ol className="space-y-3">
                    {history.map((v) => (
                      <li key={v._id || v.version} className="space-y-2 rounded-lg border px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">Version {v.version}</span>
                          {v.status && <StatusPill tone={STATUS_META[v.status]?.tone || "neutral"}>{STATUS_META[v.status]?.label || humanize(v.status)}</StatusPill>}
                          <span className="text-xs text-muted-foreground">
                            {v.sentAt ? `Sent ${fmtDate(v.sentAt)}` : v.uploadedAt ? `Uploaded ${fmtDate(v.uploadedAt)}` : ""}
                          </span>
                        </div>
                        {v.rejectionReason && <p className="whitespace-pre-wrap text-sm text-muted-foreground">“{v.rejectionReason}”</p>}
                        {v.notes && <p className="text-xs text-muted-foreground">What changed: {v.notes}</p>}
                        {v.files && v.files.length > 0 && <ProofFileChips files={v.files} />}
                      </li>
                    ))}
                  </ol>
                )}
              </Section>

              <Section title="Notes" icon={StickyNote} aside={<span className="text-xs text-muted-foreground">Only your team sees these</span>}>
                {perms.canWrite && (
                  <div className="space-y-2">
                    <Textarea
                      aria-label="New note"
                      rows={2}
                      maxLength={2000}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Customer will reply after 5 pm"
                    />
                    <div className="flex justify-end">
                      <Button size="sm" variant="outline" onClick={addNote} disabled={savingNote || !note.trim()}>
                        {savingNote && <Loader2 className="animate-spin" />}
                        Add note
                      </Button>
                    </div>
                  </div>
                )}
                {loading ? (
                  <div className="h-10 animate-pulse rounded-md bg-muted" />
                ) : comments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No notes yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {comments.map((c) => (
                      <li key={c._id} className="rounded-lg bg-muted/40 px-3 py-2">
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{c.commentedByName || "Team member"}</span>
                          <span title={fmtDate(c.commentedAt)}>{fmtRelative(c.commentedAt)}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{c.comment}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </>
        ) : (
          <>
            <SheetHeader className="border-b px-5 py-4">
              <SheetTitle>Proof</SheetTitle>
              <SheetDescription>Loading…</SheetDescription>
            </SheetHeader>
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
