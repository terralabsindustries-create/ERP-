import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, FileDown, Loader2, RefreshCw, Trash2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, MetricBar, SearchField, StatusPill, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR, plural, localDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface Payslip {
  _id: string;
  employeeName: string;
  employeeCode?: string;
  designation?: string;
  month: number;
  year: number;
  workingDays: number;
  paidDays: number;
  lopDays?: number;
  grossEarnings: number;
  totalDeductions: number;
  netPay: number;
  status: "draft" | "generated" | "paid";
  paidDate?: string;
  paymentMethod?: string;
  earnings?: Record<string, number>;
  deductions?: Record<string, number>;
}

interface Summary {
  count: number;
  totalNet: number;
  totalGross: number;
  paidCount: number;
  pendingCount: number;
  paidAmount: number;
}

type View = "all" | "unpaid" | "paid";

const STATUS: Record<Payslip["status"], { label: string; tone: PillTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  generated: { label: "To pay", tone: "warning" },
  paid: { label: "Paid", tone: "success" }
};
const PAY_METHODS: Record<string, string> = { "bank-transfer": "Bank transfer", cash: "Cash", cheque: "Cheque", upi: "UPI" };
const EARNING_LABELS: Record<string, string> = { basic: "Basic", hra: "HRA", allowances: "Allowances", specialAllowance: "Special allowance", overtime: "Overtime", bonus: "Bonus" };
const DEDUCTION_LABELS: Record<string, string> = { pf: "Provident fund", professionalTax: "Professional tax", esi: "ESI", loan: "Loan", lop: "Loss of pay", other: "Other" };

function Breakdown({ title, items, labels, total, negative }: { title: string; items?: Record<string, number>; labels: Record<string, string>; total: number; negative?: boolean }) {
  const lines = Object.entries(labels).filter(([k]) => (items?.[k] || 0) !== 0);
  return (
    <section className="rounded-lg border">
      <h3 className="border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <dl className="divide-y text-sm">
        {lines.length === 0 && <div className="px-4 py-2.5 text-muted-foreground">None</div>}
        {lines.map(([k, label]) => (
          <div key={k} className="flex items-center justify-between px-4 py-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="num">{formatINR(items?.[k] || 0)}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between bg-muted/40 px-4 py-2.5 font-semibold">
          <dt>Total</dt>
          <dd className={cn("num", negative && "text-destructive-strong")}>
            {negative && total ? "−" : ""}
            {formatINR(total)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export default function Payroll() {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canProcess = hasPermission("Payroll: Process Payroll");
  const now = new Date();
  const [period, setPeriod] = useState({ month: now.getMonth() + 1, year: now.getFullYear() });
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("all");
  const [search, setSearch] = useState("");
  const [generateOpen, setGenerateOpen] = useState(false);
  const [paying, setPaying] = useState<Payslip | null>(null);
  const [payForm, setPayForm] = useState({ paymentMethod: "bank-transfer", paidDate: "" });
  const [payBusy, setPayBusy] = useState(false);
  const [deleting, setDeleting] = useState<Payslip | null>(null);
  const [detail, setDetail] = useState<Payslip | null>(null);

  const label = `${MONTHS[period.month - 1]} ${period.year}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, sum] = (await Promise.all([apiClient.getPayroll({ month: period.month, year: period.year }), apiClient.getPayrollSummary(period.month, period.year)])) as [
        { payslips?: Payslip[] },
        Summary
      ];
      setPayslips(list?.payslips || []);
      setSummary(sum || null);
    } catch (error) {
      toast({ title: "Payroll could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [period, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const shift = (n: number) =>
    setPeriod((p) => {
      const d = new Date(p.year, p.month - 1 + n, 1);
      return { month: d.getMonth() + 1, year: d.getFullYear() };
    });

  const generate = async () => {
    try {
      const res = (await apiClient.generatePayroll(period.month, period.year)) as { generated?: number; skipped?: number };
      toast({
        title: `Payroll ready for ${label}`,
        description: `${plural(res?.generated || 0, "payslip")} worked out${res?.skipped ? `; ${res.skipped} already paid and left as they were` : ""}.`
      });
      setGenerateOpen(false);
      load();
    } catch (error) {
      toast({ title: "Payroll not generated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const markPaid = async () => {
    if (!paying) return;
    setPayBusy(true);
    try {
      await apiClient.markPayslipPaid(paying._id, { paymentMethod: payForm.paymentMethod, ...(payForm.paidDate ? { paidDate: payForm.paidDate } : {}) });
      toast({ title: "Marked as paid", description: `${paying.employeeName} · ${formatINR(paying.netPay)}. Recorded as a salary expense in Accounts.` });
      setPaying(null);
      setDetail(null);
      load();
    } catch (error) {
      toast({ title: "Not updated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setPayBusy(false);
    }
  };

  const download = async (p: Payslip) => {
    try {
      const blob = await apiClient.downloadPayslipPDF(p._id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Payslip_${p.employeeCode || "EMP"}_${p.month}_${p.year}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({ title: "Payslip not downloaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await apiClient.deletePayslip(deleting._id);
      toast({ title: "Payslip deleted" });
      setDeleting(null);
      setDetail(null);
      load();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const openPay = (p: Payslip) => {
    setPayForm({ paymentMethod: p.paymentMethod || "bank-transfer", paidDate: localDate() });
    setPaying(p);
  };

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return payslips.filter(
      (p) =>
        (view === "all" || (view === "paid" ? p.status === "paid" : p.status !== "paid")) &&
        (!q || [p.employeeName, p.employeeCode, p.designation].some((f) => (f || "").toLowerCase().includes(q)))
    );
  }, [payslips, view, search]);

  const unpaidAmount = (summary?.totalNet || 0) - (summary?.paidAmount || 0);
  const amt = (n = 0) => formatINR(n, { compact: n >= 1e5 });

  const columns: Column<Payslip>[] = [
    {
      id: "employee",
      header: "Employee",
      cell: (p) => <EntityCell avatar={p.employeeName} title={p.employeeName} subtitle={[p.employeeCode, p.designation].filter(Boolean).join(" · ")} />,
      sortValue: (p) => p.employeeName.toLowerCase(),
      className: "min-w-[220px]"
    },
    {
      id: "days",
      header: "Paid days",
      cell: (p) => (
        <div className="w-28">
          <div className="flex items-baseline justify-between text-xs">
            <span className="num font-medium text-foreground">
              {p.paidDays} / {p.workingDays}
            </span>
            {!!p.lopDays && <span className="text-destructive-strong">−{p.lopDays}</span>}
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full", p.lopDays ? "bg-warning" : "bg-success")} style={{ width: `${p.workingDays ? Math.min(100, (p.paidDays / p.workingDays) * 100) : 0}%` }} />
          </div>
        </div>
      ),
      sortValue: (p) => p.paidDays,
      hideBelow: "md"
    },
    { id: "gross", header: "Gross", align: "right", cell: (p) => formatINR(p.grossEarnings), sortValue: (p) => p.grossEarnings, hideBelow: "lg" },
    {
      id: "deductions",
      header: "Deductions",
      align: "right",
      cell: (p) => (p.totalDeductions ? <span className="text-destructive-strong">−{formatINR(p.totalDeductions)}</span> : <span className="text-muted-foreground">—</span>),
      sortValue: (p) => p.totalDeductions,
      hideBelow: "lg"
    },
    { id: "net", header: "Net pay", align: "right", cell: (p) => <span className="font-semibold">{formatINR(p.netPay)}</span>, sortValue: (p) => p.netPay },
    {
      id: "status",
      header: "Status",
      cell: (p) =>
        p.status === "paid" ? (
          <div className="flex flex-col items-start gap-0.5">
            <StatusPill tone="success">Paid</StatusPill>
            {p.paidDate && <span className="text-xs text-muted-foreground">{fmtDate(p.paidDate)}</span>}
          </div>
        ) : !canProcess ? (
          <StatusPill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</StatusPill>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2"
            onClick={(e) => {
              e.stopPropagation();
              openPay(p);
            }}
          >
            <CheckCircle2 />
            Mark paid
          </Button>
        ),
      sortValue: (p) => p.status,
      className: "w-[130px]"
    }
  ];

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="People"
        title="Payroll"
        description="Monthly payslips worked out from each person's salary and their attendance."
        actions={
          <>
            <div className="flex items-center rounded-md border bg-card">
              <Button variant="ghost" size="icon-sm" onClick={() => shift(-1)} aria-label="Previous month">
                <ChevronLeft />
              </Button>
              <Select value={`${period.year}-${period.month}`} onValueChange={(v) => setPeriod({ year: Number(v.split("-")[0]), month: Number(v.split("-")[1]) })}>
                <SelectTrigger className="h-8 w-[172px] justify-center gap-1 border-0 shadow-none focus:ring-0" aria-label="Month">
                  <SelectValue>{label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, i) => {
                    const d = new Date(now.getFullYear(), now.getMonth() + 2 - i, 1);
                    return (
                      <SelectItem key={i} value={`${d.getFullYear()}-${d.getMonth() + 1}`}>
                        {MONTHS[d.getMonth()]} {d.getFullYear()}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="icon-sm" onClick={() => shift(1)} aria-label="Next month">
                <ChevronRight />
              </Button>
            </div>
            {canProcess && (
              <Button onClick={() => setGenerateOpen(true)}>
                <RefreshCw />
                {payslips.length ? "Regenerate" : "Generate payroll"}
              </Button>
            )}
          </>
        }
      />

      <MetricBar
        loading={!summary}
        metrics={[
          { label: "Net payout", value: amt(summary?.totalNet), hint: `${plural(summary?.count || 0, "payslip")} for ${MONTHS[period.month - 1]}` },
          { label: "Gross earnings", value: amt(summary?.totalGross), hint: summary?.totalGross ? `${formatINR((summary.totalGross || 0) - (summary.totalNet || 0))} deducted` : "Before deductions" },
          {
            label: "Paid",
            value: amt(summary?.paidAmount),
            hint: plural(summary?.paidCount || 0, "person", "people"),
            tone: "success",
            onClick: () => setView(view === "paid" ? "all" : "paid"),
            active: view === "paid"
          },
          {
            label: "Still to pay",
            value: amt(unpaidAmount),
            hint: summary?.pendingCount ? plural(summary.pendingCount, "person", "people") : summary?.count ? "Everyone's paid" : "Nothing to pay yet",
            tone: summary?.pendingCount ? "warning" : "default",
            onClick: () => setView(view === "unpaid" ? "all" : "unpaid"),
            active: view === "unpaid"
          }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "all", label: "All payslips", count: payslips.length },
            { value: "unpaid", label: "To pay", count: payslips.filter((p) => p.status !== "paid").length, tone: "warning" },
            { value: "paid", label: "Paid", count: payslips.filter((p) => p.status === "paid").length }
          ]}
        />

        <DataCard
          toolbar={<Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search name, code or designation" />} />}
          footer={
            !loading &&
            rows.length > 0 && (
              <div className="flex items-center justify-between gap-3">
                <span>{plural(rows.length, "payslip")}</span>
                <span className="num">
                  Net in this view: <span className="font-semibold text-foreground">{formatINR(rows.reduce((s, p) => s + p.netPay, 0))}</span>
                </span>
              </div>
            )
          }
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(p) => p._id}
            loading={loading}
            onRowClick={(p) => setDetail(p)}
            defaultSort={{ id: "employee", dir: "asc" }}
            actions={(p) => [
              { label: "Download payslip", icon: FileDown, onClick: () => download(p) },
              { label: "Mark paid", icon: CheckCircle2, onClick: () => openPay(p), hidden: !canProcess || p.status === "paid" },
              { label: "Delete payslip", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(p), hidden: !canProcess || p.status === "paid" }
            ]}
            actionsLabel={(p) => `Actions for ${p.employeeName}`}
            mobile={(p) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium">{p.employeeName}</span>
                  <span className="num font-semibold">{formatINR(p.netPay)}</span>
                </div>
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    {p.paidDays} / {p.workingDays} days{p.totalDeductions ? ` · −${formatINR(p.totalDeductions)}` : ""}
                  </span>
                  <StatusPill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</StatusPill>
                </div>
              </div>
            )}
            empty={
              search || view !== "all" ? (
                <EmptyState compact icon={Wallet} title="No payslips in this view" />
              ) : (
                <EmptyState
                  icon={Wallet}
                  title={`No payslips for ${label}`}
                  description="Generate payroll to work out each active employee's pay from their salary and the attendance marked this month."
                  action={
                    canProcess && (
                      <Button onClick={() => setGenerateOpen(true)}>
                        <RefreshCw />
                        Generate payroll
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      <Sheet open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          {detail && (
            <>
              <SheetHeader className="border-b px-5 py-4">
                <SheetTitle>{detail.employeeName}</SheetTitle>
                <SheetDescription>
                  Payslip for {MONTHS[detail.month - 1]} {detail.year}
                  {detail.employeeCode ? ` · ${detail.employeeCode}` : ""}
                </SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
                <div className="rounded-lg border bg-muted/30 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net pay</div>
                  <div className="num mt-1 text-3xl font-semibold tracking-tight">{formatINR(detail.netPay)}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <StatusPill tone={STATUS[detail.status].tone}>{STATUS[detail.status].label}</StatusPill>
                    {detail.status === "paid" && (
                      <span>
                        {fmtDate(detail.paidDate)}
                        {detail.paymentMethod ? ` · ${PAY_METHODS[detail.paymentMethod] || detail.paymentMethod}` : ""}
                      </span>
                    )}
                  </div>
                </div>
                <dl className="grid grid-cols-3 divide-x rounded-lg border text-center text-sm">
                  <div className="p-3">
                    <dt className="text-xs text-muted-foreground">Days in month</dt>
                    <dd className="num mt-0.5 font-semibold">{detail.workingDays}</dd>
                  </div>
                  <div className="p-3">
                    <dt className="text-xs text-muted-foreground">Paid days</dt>
                    <dd className="num mt-0.5 font-semibold">{detail.paidDays}</dd>
                  </div>
                  <div className="p-3">
                    <dt className="text-xs text-muted-foreground">Loss of pay</dt>
                    <dd className={cn("num mt-0.5 font-semibold", detail.lopDays && "text-destructive-strong")}>{detail.lopDays || 0}</dd>
                  </div>
                </dl>
                <Breakdown title="Earnings" items={detail.earnings} labels={EARNING_LABELS} total={detail.grossEarnings} />
                <Breakdown title="Deductions" items={detail.deductions} labels={DEDUCTION_LABELS} total={detail.totalDeductions} negative />
              </div>
              <div className="flex flex-col-reverse gap-2 border-t bg-card px-5 py-3 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => download(detail)}>
                  <FileDown />
                  Download PDF
                </Button>
                {canProcess && detail.status !== "paid" && (
                  <Button onClick={() => openPay(detail)}>
                    <CheckCircle2 />
                    Mark paid
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={!!paying} onOpenChange={(o) => !o && !payBusy && setPaying(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark as paid</DialogTitle>
            <DialogDescription>{paying ? `${paying.employeeName} · ${formatINR(paying.netPay)} for ${MONTHS[paying.month - 1]} ${paying.year}. This also records a salary expense in Accounts.` : null}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pay-method">Paid by</Label>
              <Select value={payForm.paymentMethod} onValueChange={(v) => setPayForm({ ...payForm, paymentMethod: v })}>
                <SelectTrigger id="pay-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PAY_METHODS).map(([value, l]) => (
                    <SelectItem key={value} value={value}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-date">Paid on</Label>
              <Input id="pay-date" type="date" value={payForm.paidDate} onChange={(e) => setPayForm({ ...payForm, paidDate: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaying(null)} disabled={payBusy}>
              Cancel
            </Button>
            <Button onClick={markPaid} disabled={payBusy}>
              {payBusy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              Mark paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        title={`${payslips.length ? "Regenerate" : "Generate"} payroll for ${label}?`}
        description={
          payslips.length
            ? "Unpaid payslips are worked out again from current salaries and attendance. Paid payslips are left as they are."
            : "A payslip is worked out for every active employee from their salary structure and the attendance marked this month."
        }
        confirmLabel={payslips.length ? "Regenerate" : "Generate"}
        cancelLabel="Cancel"
        destructive={false}
        onConfirm={generate}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this payslip?"
        description={deleting ? `${deleting.employeeName} · ${formatINR(deleting.netPay)}. You can generate it again later.` : undefined}
        onConfirm={remove}
      />
    </PageShell>
  );
}
