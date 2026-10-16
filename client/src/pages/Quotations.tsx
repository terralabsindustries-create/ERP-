import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Ban, CheckCircle, ClipboardList, Download, Lock, Mail, MessageSquare, Plus, Receipt, RotateCcw, Send, TimerOff, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, MetricBar, SearchField, Stack, StatusPill, Toolbar, ViewTabs, type Column, type PillTone, type RowAction } from "@/components/data";
import { CreateQuotationDialog } from "@/components/quotations/CreateQuotationDialog";
import { SendQuotationEmailDialog, SendQuotationWhatsAppDialog } from "@/components/quotations/SendQuotationDialogs";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { daysUntil, fmtDate, formatINR, plural } from "@/lib/format";

type QuotationStatus = "draft" | "sent" | "approved" | "rejected" | "expired" | "converted" | "closed";

interface Quotation {
  _id: string;
  quotationNumber: string;
  customer_id: { _id: string; name: string; email?: string; phone?: string } | null;
  /** Quotations written before GST was removed may say "gst" and carry tax_amount. */
  gst_type?: "gst" | "non_gst";
  valid_until: string;
  status: QuotationStatus;
  subtotal?: number;
  design_charge?: number;
  tax_amount?: number;
  total_amount: number;
  createdAt: string;
  convertedInvoiceNumber?: string;
}

const STATUS: Record<QuotationStatus, { label: string; tone: PillTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  sent: { label: "Sent", tone: "info" },
  approved: { label: "Approved", tone: "primary" },
  converted: { label: "Invoiced", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  expired: { label: "Expired", tone: "warning" },
  closed: { label: "Closed", tone: "neutral" }
};

type View = "all" | "open" | "draft" | "sent" | "approved" | "converted" | "lost";
const OPEN: QuotationStatus[] = ["draft", "sent", "approved"];
const inView = (q: Quotation, v: View) =>
  v === "all" ? true : v === "open" ? OPEN.includes(q.status) : v === "lost" ? ["rejected", "expired", "closed"].includes(q.status) : q.status === v;
const customerOf = (q: Quotation) => q.customer_id?.name || "—";
// Draft, sent or approved but past its validity date.
const lapsed = (q: Quotation) => OPEN.includes(q.status) && (daysUntil(q.valid_until) ?? 0) < 0;

export default function Quotations() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("open");
  const [emailing, setEmailing] = useState<Quotation | null>(null);
  const [whatsapping, setWhatsapping] = useState<Quotation | null>(null);
  const [converting, setConverting] = useState<Quotation | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Quotation | null>(null);

  const canEdit = hasPermission("Quotations: Create & Edit");
  const canDelete = hasPermission("Quotations: Delete");
  const canSend = hasPermission("Quotations: Send Email");
  const canStatus = hasPermission("Quotations: Change Status");
  const canConvert = hasPermission("Quotations: Convert to Invoice");
  const canWhatsApp = hasPermission("WhatsApp: Send Messages");

  const load = useCallback(async () => {
    try {
      const res = (await apiClient.getQuotations({ limit: 500 })) as { quotations?: Quotation[] };
      setQuotations(res?.quotations || []);
    } catch (error) {
      toast({ title: "Quotations could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return quotations.filter((q) => inView(q, view) && (!s || q.quotationNumber.toLowerCase().includes(s) || customerOf(q).toLowerCase().includes(s)));
  }, [quotations, search, view]);

  const count = (v: View) => quotations.filter((q) => inView(q, v)).length;
  const sum = (list: Quotation[]) => list.reduce((s, q) => s + (q.total_amount || 0), 0);
  const open = quotations.filter((q) => OPEN.includes(q.status));
  const sent = quotations.filter((q) => q.status === "sent");
  const approved = quotations.filter((q) => q.status === "approved");
  const won = quotations.filter((q) => q.status === "converted" || q.status === "approved").length;
  const decided = quotations.filter((q) => ["converted", "approved", "rejected", "expired"].includes(q.status)).length;
  const amt = (n: number) => formatINR(n, { compact: n >= 1e5 });

  const setStatus = async (q: Quotation, status: QuotationStatus) => {
    const previous = q.status;
    setQuotations((list) => list.map((x) => (x._id === q._id ? { ...x, status } : x)));
    try {
      await apiClient.updateQuotationStatus(q._id, status);
      toast({ title: `${q.quotationNumber} is now ${STATUS[status].label.toLowerCase()}` });
    } catch (error) {
      setQuotations((list) => list.map((x) => (x._id === q._id ? { ...x, status: previous } : x)));
      toast({ title: "Status not changed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const download = async (q: Quotation) => {
    try {
      const blob = await apiClient.downloadQuotationPDF(q._id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Quotation_${q.quotationNumber}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({ title: "PDF not ready", description: error instanceof Error ? error.message : "Check the company details in Settings.", variant: "destructive" });
    }
  };

  const convert = async () => {
    const q = converting;
    if (!q) return;
    setBusy(true);
    try {
      const res = (await apiClient.convertQuotationToInvoice(q._id)) as { invoice?: { invoiceNumber?: string } };
      toast({ title: "Invoice created", description: `${q.quotationNumber} → ${res?.invoice?.invoiceNumber ?? "draft invoice"}` });
      setConverting(null);
      load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not convert this quotation.";
      // The server may have finished even though we stopped waiting.
      if (/already converted|timed out/i.test(message)) {
        toast({ title: /timed/i.test(message) ? "Still processing" : "Already invoiced", description: message });
        setConverting(null);
        load();
      } else {
        toast({ title: "Not converted", description: message, variant: "destructive" });
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteQuotation(deleting._id);
      toast({ title: `${deleting.quotationNumber} deleted` });
      setDeleting(null);
      load();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const actions = (q: Quotation): RowAction[] => {
    const finished = q.status === "converted" || q.status === "closed";
    return [
      { label: "Download PDF", icon: Download, onClick: () => download(q) },
      { label: "Email to customer", icon: Mail, onClick: () => setEmailing(q), hidden: !canSend || finished },
      { label: "Send on WhatsApp", icon: MessageSquare, onClick: () => setWhatsapping(q), hidden: !canWhatsApp || finished },
      {
        label: "Convert to invoice",
        icon: Receipt,
        onClick: () => setConverting(q),
        hidden: !canConvert || !OPEN.includes(q.status),
        separated: true
      },
      {
        label: `Open invoice ${q.convertedInvoiceNumber || ""}`.trim(),
        icon: Receipt,
        onClick: () => navigate(`/invoices?q=${encodeURIComponent(q.convertedInvoiceNumber || "")}`),
        hidden: q.status !== "converted",
        separated: true
      },
      { label: "Mark sent", icon: Send, onClick: () => setStatus(q, "sent"), hidden: !canStatus || q.status !== "draft", separated: true },
      { label: "Mark approved", icon: CheckCircle, onClick: () => setStatus(q, "approved"), hidden: !canStatus || !["draft", "sent"].includes(q.status) },
      { label: "Mark rejected", icon: XCircle, onClick: () => setStatus(q, "rejected"), hidden: !canStatus || !OPEN.includes(q.status) },
      { label: "Mark expired", icon: TimerOff, onClick: () => setStatus(q, "expired"), hidden: !canStatus || !OPEN.includes(q.status) },
      { label: "Close", icon: Lock, onClick: () => setStatus(q, "closed"), hidden: !canStatus || finished },
      { label: "Reopen as draft", icon: RotateCcw, onClick: () => setStatus(q, "draft"), hidden: !canStatus || !["rejected", "expired", "closed"].includes(q.status) },
      { label: "Delete quotation", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(q), hidden: !canDelete || q.status === "converted" }
    ];
  };

  const columns: Column<Quotation>[] = [
    {
      id: "number",
      header: "Quotation",
      cell: (q) => (
        <EntityCell title={q.quotationNumber} mono subtitle={(q.design_charge || 0) > 0 ? `Design charge ${formatINR(q.design_charge || 0)}` : undefined} />
      ),
      sortValue: (q) => q.quotationNumber,
      className: "min-w-[190px]"
    },
    { id: "customer", header: "Customer", cell: (q) => <EntityCell avatar={customerOf(q)} title={customerOf(q)} subtitle={q.customer_id?.phone} />, sortValue: (q) => customerOf(q).toLowerCase() },
    { id: "created", header: "Created", cell: (q) => <span className="whitespace-nowrap">{fmtDate(q.createdAt)}</span>, sortValue: (q) => q.createdAt, hideBelow: "lg" },
    {
      id: "valid",
      header: "Valid until",
      cell: (q) => {
        const d = daysUntil(q.valid_until);
        return (
          <Stack
            top={<span className="whitespace-nowrap">{fmtDate(q.valid_until)}</span>}
            bottom={
              OPEN.includes(q.status) && d !== null ? (
                <span className={d < 0 ? "text-destructive-strong" : d <= 3 ? "text-warning-strong" : undefined}>
                  {d < 0 ? `Lapsed ${-d} day${d === -1 ? "" : "s"} ago` : d === 0 ? "Last day" : `${d} day${d === 1 ? "" : "s"} left`}
                </span>
              ) : undefined
            }
          />
        );
      },
      sortValue: (q) => q.valid_until || "",
      hideBelow: "md"
    },
    { id: "amount", header: "Amount", align: "right", cell: (q) => <span className="font-semibold">{formatINR(q.total_amount || 0)}</span>, sortValue: (q) => q.total_amount },
    {
      id: "status",
      header: "Status",
      cell: (q) => (
        <div className="flex flex-col items-start gap-0.5">
          <StatusPill tone={STATUS[q.status]?.tone || "neutral"}>{STATUS[q.status]?.label || q.status}</StatusPill>
          {q.status === "converted" && q.convertedInvoiceNumber && <span className="font-mono text-[11px] text-muted-foreground">{q.convertedInvoiceNumber}</span>}
        </div>
      ),
      sortValue: (q) => q.status,
      className: "w-[120px]"
    }
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Sales & estimating"
        title="Quotations"
        description="Estimates sent to customers — what's waiting for a reply, what's approved and ready to bill."
        actions={
          canEdit && (
            <CreateQuotationDialog onQuotationCreated={load}>
              <Button>
                <Plus />
                New quotation
              </Button>
            </CreateQuotationDialog>
          )
        }
      />

      <MetricBar
        loading={loading}
        metrics={[
          { label: "Open pipeline", value: amt(sum(open)), hint: plural(open.length, "open quotation"), onClick: () => setView("open"), active: view === "open" },
          { label: "Awaiting reply", value: amt(sum(sent)), hint: plural(sent.length, "sent quotation"), tone: "info", onClick: () => setView(view === "sent" ? "open" : "sent"), active: view === "sent" },
          {
            label: "Ready to invoice",
            value: amt(sum(approved)),
            hint: plural(approved.length, "approved quotation"),
            tone: approved.length ? "success" : "default",
            onClick: () => setView(view === "approved" ? "open" : "approved"),
            active: view === "approved"
          },
          { label: "Win rate", value: decided ? `${Math.round((won / decided) * 100)}%` : "—", hint: decided ? `${won} of ${decided} decided` : "No decisions yet" }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "open", label: "Open", count: count("open") },
            { value: "draft", label: "Drafts", count: count("draft") },
            { value: "sent", label: "Sent", count: count("sent") },
            { value: "approved", label: "Approved", count: count("approved") },
            { value: "converted", label: "Invoiced", count: count("converted") },
            { value: "lost", label: "Lost & closed", count: count("lost") },
            { value: "all", label: "All", count: quotations.length }
          ]}
        />

        <DataCard
          toolbar={<Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search quotation no. or customer" />} />}
          footer={
            !loading &&
            rows.length > 0 && (
              <div className="flex justify-between gap-3">
                <span>{plural(rows.length, "quotation")}</span>
                <span className="num">Value: {formatINR(sum(rows))}</span>
              </div>
            )
          }
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(q) => q._id}
            loading={loading}
            actions={actions}
            actionsLabel={(q) => `Actions for ${q.quotationNumber}`}
            rowClassName={(q) => (lapsed(q) ? "bg-warning-soft/20" : undefined)}
            defaultSort={{ id: "created", dir: "desc" }}
            mobile={(q) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium">{customerOf(q)}</span>
                  <span className="num font-semibold">{formatINR(q.total_amount || 0)}</span>
                </div>
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="font-mono">
                    {q.quotationNumber} · valid to {fmtDate(q.valid_until)}
                  </span>
                  <StatusPill tone={STATUS[q.status]?.tone || "neutral"}>{STATUS[q.status]?.label || q.status}</StatusPill>
                </div>
              </div>
            )}
            empty={
              quotations.length === 0 ? (
                <EmptyState
                  icon={ClipboardList}
                  title="No quotations yet"
                  description="Price a job in the Print Estimator, or write a quotation here and send it to the customer."
                  action={
                    canEdit && (
                      <CreateQuotationDialog onQuotationCreated={load}>
                        <Button>
                          <Plus />
                          New quotation
                        </Button>
                      </CreateQuotationDialog>
                    )
                  }
                />
              ) : (
                <EmptyState compact icon={Ban} title="No quotations in this view" />
              )
            }
          />
        </DataCard>
      </div>

      <Dialog open={!!converting} onOpenChange={(o) => !o && !busy && setConverting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Convert to invoice</DialogTitle>
          </DialogHeader>
          {converting && (() => {
            // An older quotation written with GST is invoiced at its prices before tax.
            const legacyGst = converting.gst_type === "gst" ? converting.tax_amount || 0 : 0;
            const invoiceTotal = converting.total_amount - legacyGst;
            return (
            <div className="space-y-3 text-sm">
              <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border">
                {[
                  ["Quotation", converting.quotationNumber],
                  ["Customer", customerOf(converting)],
                  ["Invoice total", formatINR(invoiceTotal)]
                ].map(([k, v]) => (
                  <div key={k} className="min-w-0 bg-card px-3 py-2">
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="truncate font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
              {(converting.design_charge || 0) > 0 && (
                <p>
                  The design charge of <span className="font-medium">{formatINR(converting.design_charge || 0)}</span> carries over as its own line.
                </p>
              )}
              {legacyGst > 0 && (
                <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning-strong">
                  This quotation was written with GST of {formatINR(legacyGst)}. Invoices carry no GST, so the invoice is raised for {formatINR(invoiceTotal)}.
                </p>
              )}
              <p className="text-muted-foreground">
                A draft invoice is created with these items and their sizes, due in 30 days. The quotation stays on record, marked Invoiced, and can't be invoiced again.
              </p>
            </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConverting(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={convert} disabled={busy}>
              <Receipt />
              {busy ? "Creating…" : "Create invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SendQuotationEmailDialog quotation={emailing} onOpenChange={(o) => !o && setEmailing(null)} onSent={load} />
      <SendQuotationWhatsAppDialog quotation={whatsapping} onOpenChange={(o) => !o && setWhatsapping(null)} onSent={load} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.quotationNumber}?`} description="The quotation is removed permanently." onConfirm={remove} />
    </PageShell>
  );
}
