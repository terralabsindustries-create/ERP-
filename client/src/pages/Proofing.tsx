import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { CheckCircle2, Eye, FileCheck2, MessageSquareWarning, Pencil, Plus, Send, Share2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, MetricBar, Pagination, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type ViewTab } from "@/components/data";
import { ApproveDialog, RequestChangesDialog } from "@/components/proofing/DecisionDialogs";
import { NewVersionDialog } from "@/components/proofing/NewVersionDialog";
import { ProofDetailSheet } from "@/components/proofing/ProofDetailSheet";
import { ProofEditorSheet, type SavedAs } from "@/components/proofing/ProofEditorSheet";
import { ShareProofDialog } from "@/components/proofing/ShareProofDialog";
import { STATUS_META, availableActions, customerPhoneOf, fmtPhone, jobOf, jobTitleOf, lastEvent, replyDue, type ProofAction, type ProofPermissions } from "@/components/proofing/proofMeta";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import { proofsApi, type Proof, type ProofListResponse, type ProofStats, type ProofView } from "@/lib/api/proofs";
import { fmtDate, humanize, plural } from "@/lib/format";

const PAGE_SIZE = 25;

export default function Proofing() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const perms: ProofPermissions = {
    canWrite: hasPermission("Job Proofing"),
    canApprove: hasPermission("Job Proofing: Approve"),
    canReject: hasPermission("Job Proofing: Reject")
  };

  const [data, setData] = useState<ProofListResponse | null>(null);
  const [stats, setStats] = useState<ProofStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [view, setView] = useState<ProofView>("all");
  const [page, setPage] = useState(1);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Proof | null>(null);
  const [detail, setDetail] = useState<Proof | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [share, setShare] = useState<{ proof: Proof; markSent: boolean } | null>(null);
  const [approving, setApproving] = useState<Proof | null>(null);
  const [rejecting, setRejecting] = useState<Proof | null>(null);
  const [versioning, setVersioning] = useState<Proof | null>(null);
  const [deleting, setDeleting] = useState<Proof | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await proofsApi.list({ view, search: q || undefined, page, limit: PAGE_SIZE }));
    } catch (error) {
      toast({ title: "Proofs could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [view, q, page, toast]);

  const loadStats = useCallback(() => {
    proofsApi
      .stats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadStats();
  }, [loadStats]);
  useEffect(() => setPage(1), [q, view]);

  const refresh = () => {
    load();
    loadStats();
  };

  /** Show the latest copy of a proof in the open panel, and refresh the list. */
  const applyUpdate = (p: Proof) => {
    setDetail((d) => (d && d._id === p._id ? p : d));
    refresh();
  };

  const openDetail = (p: Proof) => {
    setDetail(p);
    setDetailOpen(true);
    setDetailLoading(true);
    proofsApi
      .get(p._id)
      .then((full) => setDetail((d) => (d && d._id === full._id ? full : d)))
      .catch((error) => toast({ title: "Proof could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" }))
      .finally(() => setDetailLoading(false));
  };

  const onAction = (action: ProofAction, p: Proof) => {
    switch (action) {
      case "send":
        return setShare({ proof: p, markSent: true });
      case "share":
        return setShare({ proof: p, markSent: false });
      case "approve":
        return setApproving(p);
      case "reject":
        return setRejecting(p);
      case "version":
        return setVersioning(p);
      case "edit":
        setEditing(p);
        return setEditorOpen(true);
      case "delete":
        return setDeleting(p);
    }
  };

  const onSaved = (p: Proof, savedAs: SavedAs) => {
    setEditorOpen(false);
    if (savedAs === "edit") {
      toast({ title: "Changes saved" });
      applyUpdate(p);
      return;
    }
    toast({ title: `${p.proofNumber} created`, description: savedAs === "sent" ? "Marked as sent. Share it with the customer now." : "Saved as a draft." });
    refresh();
    if (savedAs === "sent") setShare({ proof: p, markSent: false });
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await proofsApi.remove(deleting._id);
      toast({ title: `${deleting.proofNumber} deleted` });
      if (detail?._id === deleting._id) setDetailOpen(false);
      setDeleting(null);
      refresh();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const newProof = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const s = data?.summary;
  const rows = data?.proofs || [];
  const total = data?.pagination.totalProofs || 0;
  const toggle = (v: ProofView) => setView(view === v ? "all" : v);

  const statusCell = (p: Proof) => {
    const due = replyDue(p);
    const meta = STATUS_META[p.status];
    return (
      <Stack
        top={<StatusPill tone={due?.overdue ? "warning" : meta.tone}>{due?.overdue ? "Overdue" : meta.label}</StatusPill>}
        bottom={
          p.status === "rejected" && p.approval?.rejectionReason ? (
            <span title={p.approval.rejectionReason}>{p.approval.rejectionReason}</span>
          ) : due ? (
            <span className={due.overdue ? "text-warning-strong" : undefined}>{due.text}</span>
          ) : undefined
        }
      />
    );
  };

  const columns: Column<Proof>[] = [
    {
      id: "proof",
      header: "Proof",
      cell: (p) => <EntityCell icon={FileCheck2} title={p.title} subtitle={<span className="font-mono">{p.proofNumber}</span>} />,
      sortValue: (p) => p.proofNumber,
      className: "min-w-[240px]"
    },
    {
      id: "job",
      header: "Job",
      cell: (p) => <Stack top={jobTitleOf(p)} bottom={jobOf(p)?.status ? humanize(jobOf(p)?.status) : undefined} />,
      sortValue: (p) => jobTitleOf(p).toLowerCase(),
      hideBelow: "lg",
      className: "max-w-[220px]"
    },
    {
      id: "customer",
      header: "Customer",
      cell: (p) => <Stack top={p.customerName} bottom={customerPhoneOf(p) ? fmtPhone(customerPhoneOf(p)) : undefined} />,
      sortValue: (p) => p.customerName.toLowerCase(),
      hideBelow: "md",
      className: "max-w-[200px]"
    },
    { id: "version", header: "Version", align: "center", cell: (p) => <Tag>v{p.version}</Tag>, sortValue: (p) => p.version, className: "w-[90px]" },
    { id: "status", header: "Status", cell: statusCell, sortValue: (p) => p.status, className: "w-[200px] max-w-[220px]" },
    {
      id: "date",
      header: "Last update",
      cell: (p) => {
        const e = lastEvent(p);
        return <Stack top={<span className="whitespace-nowrap">{fmtDate(e.date)}</span>} bottom={e.label} />;
      },
      sortValue: (p) => lastEvent(p).date || "",
      className: "w-[130px]"
    }
  ];

  const tabs: ViewTab<ProofView>[] = [
    { value: "all", label: "All", count: s?.all },
    { value: "draft", label: "Drafts", count: s?.draft },
    { value: "waiting", label: "Waiting for customer", count: s?.waiting },
    ...(s?.overdue || view === "overdue" ? [{ value: "overdue" as const, label: "Overdue", count: s?.overdue, tone: "warning" as const }] : []),
    { value: "rejected", label: "Changes requested", count: s?.rejected, tone: "danger" },
    { value: "approved", label: "Approved", count: s?.approved }
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Production"
        title="Proofing"
        description="Artwork sent to customers for sign-off before anything goes to press."
        actions={
          perms.canWrite && (
            <Button onClick={newProof}>
              <Plus />
              New proof
            </Button>
          )
        }
      />

      <MetricBar
        loading={!stats}
        metrics={[
          {
            label: "Waiting for approval",
            value: stats?.waiting ?? 0,
            hint: stats?.waiting ? `${plural(stats.waiting, "proof")} with customers` : "Nothing waiting",
            tone: stats?.waiting ? "info" : "default",
            onClick: () => toggle("waiting"),
            active: view === "waiting"
          },
          {
            label: `Approved in ${format(new Date(), "MMM")}`,
            value: stats?.approvedThisMonth ?? 0,
            hint: `${plural(stats?.approved || 0, "proof")} approved in all`,
            tone: stats?.approvedThisMonth ? "success" : "default",
            onClick: () => toggle("approved"),
            active: view === "approved"
          },
          {
            label: "Changes requested",
            value: stats?.rejected ?? 0,
            hint: stats?.rejected ? "Need a new version" : "None to fix",
            tone: stats?.rejected ? "danger" : "default",
            onClick: () => toggle("rejected"),
            active: view === "rejected"
          },
          {
            label: "Overdue replies",
            value: stats?.overdue ?? 0,
            hint: stats?.overdue ? "Past the reply-by date" : "Nothing overdue",
            tone: stats?.overdue ? "warning" : "default",
            onClick: () => toggle("overdue"),
            active: view === "overdue"
          }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<ProofView> value={view} onChange={setView} tabs={tabs} />

        <DataCard
          toolbar={<Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search proof no., job or customer" />} />}
          footer={!loading && total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="proofs" />}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(p) => p._id}
            loading={loading}
            onRowClick={openDetail}
            actions={(p) => {
              const can = availableActions(p, perms);
              return [
                { label: "Open", icon: Eye, onClick: () => openDetail(p) },
                { label: "Send to customer", icon: Send, onClick: () => onAction("send", p), hidden: !can.send },
                { label: "Share again", icon: Share2, onClick: () => onAction("share", p), hidden: !can.share },
                { label: "Record approval", icon: CheckCircle2, onClick: () => onAction("approve", p), hidden: !can.approve },
                { label: "Changes requested", icon: MessageSquareWarning, onClick: () => onAction("reject", p), hidden: !can.reject },
                { label: "Upload new version", icon: Upload, onClick: () => onAction("version", p), hidden: !can.version },
                { label: "Edit details", icon: Pencil, onClick: () => onAction("edit", p), hidden: !can.edit },
                { label: "Delete proof", icon: Trash2, destructive: true, separated: true, onClick: () => onAction("delete", p), hidden: !can.delete }
              ];
            }}
            actionsLabel={(p) => `Actions for ${p.proofNumber}`}
            mobile={(p) => {
              const due = replyDue(p);
              const meta = STATUS_META[p.status];
              return (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{p.title}</span>
                    <StatusPill tone={due?.overdue ? "warning" : meta.tone}>{due?.overdue ? "Overdue" : meta.label}</StatusPill>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    <span className="font-mono">{p.proofNumber}</span> · v{p.version} · {p.customerName}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {jobTitleOf(p)} · {lastEvent(p).label} {fmtDate(lastEvent(p).date)}
                  </div>
                </div>
              );
            }}
            empty={
              q || view !== "all" ? (
                <EmptyState compact icon={FileCheck2} title="No proofs in this view" description="Try another view or search." />
              ) : (
                <EmptyState
                  icon={FileCheck2}
                  title="No proofs yet"
                  description="Upload the artwork for a job, send it to the customer and record their approval before printing."
                  action={
                    perms.canWrite && (
                      <Button onClick={newProof}>
                        <Plus />
                        New proof
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      <ProofEditorSheet open={editorOpen} onOpenChange={setEditorOpen} proof={editing} onSaved={onSaved} />
      <ProofDetailSheet proof={detail} loading={detailLoading} open={detailOpen} onOpenChange={setDetailOpen} perms={perms} onAction={onAction} onChanged={applyUpdate} />
      <ShareProofDialog
        proof={share?.proof || null}
        open={!!share}
        markSent={!!share?.markSent}
        onOpenChange={(o) => !o && setShare(null)}
        onSent={applyUpdate}
      />
      <ApproveDialog proof={approving} onOpenChange={(o) => !o && setApproving(null)} onDone={applyUpdate} />
      <RequestChangesDialog proof={rejecting} onOpenChange={(o) => !o && setRejecting(null)} onDone={applyUpdate} />
      <NewVersionDialog
        proof={versioning}
        onOpenChange={(o) => !o && setVersioning(null)}
        onDone={(p, sent) => {
          applyUpdate(p);
          if (sent) setShare({ proof: p, markSent: false });
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this proof?"
        description={deleting ? `${deleting.proofNumber} · ${deleting.title}, with its version history and notes. The uploaded files stay with the job. This can't be undone.` : undefined}
        onConfirm={remove}
      />
    </PageShell>
  );
}
