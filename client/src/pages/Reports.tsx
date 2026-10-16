import { useState, useEffect, useCallback } from "react";
import { format } from "date-fns";
import { Download, Mail, Calendar, FileText, Info } from "lucide-react";
import { StatCard } from "@/components/common/StatTile";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { formatINR } from "@/lib/printWorkflow";
import { cn } from "@/lib/utils";

interface Slab {
  count: number;
  amount: number;
  tax: number;
}

/**
 * GET /api/reports/revenue — see backend/src/routes/reports.js for how each
 * figure is counted. GST figures only come from invoices issued before GST was
 * removed, so they are 0 for later months.
 */
interface MonthlyReportData {
  month: string;
  period: string;
  generatedAt: string;
  totalInvoices: number;
  totalRevenue: number;
  totalDiscounts: number;
  taxableAmount: number;
  totalTaxPayable: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  gstBreakdown: Record<string, Slab>;
  excludedNoGst: { count: number; amount: number };
}

const isMonthlyReportData = (value: unknown): value is MonthlyReportData => {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const totals = ["totalInvoices", "totalRevenue", "totalDiscounts", "taxableAmount", "totalTaxPayable", "cgstAmount", "sgstAmount", "igstAmount"];
  return typeof r.month === "string" && totals.every((k) => typeof r[k] === "number") && !!r.gstBreakdown && typeof r.gstBreakdown === "object";
};

interface Figure {
  amount: number;
  count: number;
}

/** GET /api/reports/design-charges — issued invoices and quotations, never added together. */
interface DesignChargeReport {
  year: number;
  months: { month: number; label: string; invoiced: Figure; quoted: Figure; convertedQuotes: Figure }[];
  totals: { invoiced: Figure; quoted: Figure; convertedQuotes: Figure };
  years: { year: number; invoiced: Figure; quoted: Figure }[];
  sources: { invoiced: string; quoted: string };
}

const rateOf = (key: string) => Number(key.replace("gst", ""));

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default function Reports() {
  const { hasPermission } = useAuth();
  const canExport = hasPermission("Reports: Export");
  const [reportData, setReportData] = useState<MonthlyReportData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState(format(new Date(), "yyyy-MM"));
  const [loading, setLoading] = useState(false);
  const [accountantNotes, setAccountantNotes] = useState("");
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailData, setEmailData] = useState({ email: "", subject: "", message: "" });
  const [designYear, setDesignYear] = useState(new Date().getFullYear());
  const [design, setDesign] = useState<DesignChargeReport | null>(null);
  const [designError, setDesignError] = useState<string | null>(null);
  const { toast } = useToast();

  const generateReport = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await apiClient.getRevenueReports({ month: selectedMonth });
      if (isMonthlyReportData(response)) {
        setReportData(response);
      } else {
        setReportData(null);
        setLoadError("The reports service returned an unexpected response.");
      }
    } catch (error) {
      setReportData(null);
      setLoadError(error instanceof Error ? error.message : "Failed to generate report");
    } finally {
      setLoading(false);
    }
  }, [selectedMonth]);

  useEffect(() => {
    generateReport();
  }, [generateReport]);

  // The design charge table follows the year of the month being looked at.
  useEffect(() => {
    const y = Number(selectedMonth.slice(0, 4));
    if (y) setDesignYear(y);
  }, [selectedMonth]);

  useEffect(() => {
    let cancelled = false;
    setDesignError(null);
    apiClient
      .getDesignChargeReport(designYear)
      .then((res) => !cancelled && setDesign(res as DesignChargeReport))
      .catch((error) => {
        if (cancelled) return;
        setDesign(null);
        setDesignError(error instanceof Error ? error.message : "The design charge report could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [designYear]);

  const designYears = Array.from(new Set([new Date().getFullYear(), designYear, ...(design?.years || []).map((y) => y.year)])).sort((a, b) => b - a);

  const slabs = reportData
    ? Object.entries(reportData.gstBreakdown).sort(([a], [b]) => rateOf(a) - rateOf(b))
    : [];
  // Invoices are issued without GST; only a month with older GST invoices has any.
  const hasGst = !!reportData && reportData.totalTaxPayable > 0;

  const exportToCSV = () => {
    if (!reportData) return;
    const designMonth = design?.year === Number(selectedMonth.slice(0, 4)) ? design.months[Number(selectedMonth.slice(5, 7)) - 1] : null;
    const rows: unknown[][] = [
      ["Monthly report", reportData.month],
      [],
      ["Summary"],
      ["Invoices", reportData.totalInvoices],
      ["Net value", reportData.taxableAmount],
      ["Discounts", reportData.totalDiscounts],
      ...(hasGst ? [["GST on older invoices", reportData.totalTaxPayable]] : []),
      ["Total invoiced", reportData.totalRevenue],
      ...(designMonth
        ? [
            [],
            ["Design charges", "Amount", "Documents"],
            ["Invoiced (issued invoices)", designMonth.invoiced.amount, designMonth.invoiced.count],
            ["Quoted (quotations, not added to invoiced)", designMonth.quoted.amount, designMonth.quoted.count]
          ]
        : []),
      ...(hasGst
        ? [
            [],
            ["GST rate (older invoices)", "Invoices", "Taxable value", "GST"],
            ...slabs.map(([key, s]) => [`${rateOf(key)}%`, s.count, s.amount, s.tax]),
            [],
            ["CGST", reportData.cgstAmount],
            ["SGST", reportData.sgstAmount],
            ["IGST", reportData.igstAmount]
          ]
        : []),
      [],
      ["Older No GST bills (not included above)", reportData.excludedNoGst.count, reportData.excludedNoGst.amount],
      [],
      ["Notes", accountantNotes]
    ];
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    const url = window.URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `monthly-report-${selectedMonth}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const openEmailDialog = () => {
    if (!reportData) return;
    setEmailError(null);
    setEmailData((prev) => ({
      email: prev.email,
      subject: `Monthly report for ${reportData.month}`,
      message: `Please find attached the sales summary for ${reportData.month}.`
    }));
    setEmailDialogOpen(true);
  };

  const sendEmailToAccountant = async () => {
    setSending(true);
    setEmailError(null);
    try {
      await apiClient.emailRevenueReport({
        month: selectedMonth,
        email: emailData.email.trim(),
        subject: emailData.subject,
        message: emailData.message,
        notes: accountantNotes
      });
      toast({ title: "Report sent", description: `The ${reportData?.month} report was emailed to ${emailData.email.trim()}.` });
      setEmailDialogOpen(false);
    } catch (error) {
      const err = error as Error & { code?: string };
      setEmailError(
        err.code === "EMAIL_NOT_CONFIGURED" || err.code === "EMAIL_AUTH_FAILED"
          ? "Email isn't set up on the server yet, so nothing was sent. Ask your admin to configure email, or use Export CSV and send the file yourself."
          : err.message || "The report could not be sent."
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="page-frame">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">Monthly Reports</h1>
          <p>What was invoiced each month, and design charges by month and year</p>
        </div>
        {canExport && (
          <div>
            <Button onClick={exportToCSV} disabled={!reportData} variant="outline">
              <Download />
              Export CSV
            </Button>
            <Button onClick={openEmailDialog} disabled={!reportData}>
              <Mail />
              Email to Accountant
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            Report period
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="month">Month</Label>
              <Input id="month" type="month" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="w-48" />
            </div>
            <Button onClick={generateReport} loading={loading} variant="outline">
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {loadError && !loading && (
        <Card>
          <EmptyState icon={FileText} title="The report could not be loaded" description={loadError} />
        </Card>
      )}

      {reportData && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Invoices" value={reportData.totalInvoices} hint={`Issued in ${reportData.month}`} />
            <StatCard label="Net value" value={formatINR(reportData.taxableAmount)} hint="Lines and design charges, after discounts" />
            <StatCard label="Discounts" value={formatINR(reportData.totalDiscounts)} hint="Invoice-level discounts" />
            <StatCard label="Total invoiced" value={formatINR(reportData.totalRevenue)} hint={hasGst ? `Includes ${formatINR(reportData.totalTaxPayable)} GST on older invoices` : "Invoices carry no GST"} />
          </div>

          {reportData.totalInvoices === 0 && (
            <Card>
              <EmptyState compact icon={FileText} title={`No invoices issued in ${reportData.month}`} description="Drafts and cancelled invoices are not counted." />
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <CardTitle className="text-base">Design charges</CardTitle>
                <p className="text-sm text-muted-foreground">By month, from saved invoices and quotations. The two columns are separate figures and are never added together.</p>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="design-year" className="text-sm font-normal text-muted-foreground">
                  Year
                </Label>
                <Select value={String(designYear)} onValueChange={(v) => setDesignYear(Number(v))}>
                  <SelectTrigger id="design-year" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {designYears.map((y) => (
                      <SelectItem key={y} value={String(y)}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 p-0 pb-5">
              {designError ? (
                <p className="px-5 text-sm text-destructive-strong">{designError}</p>
              ) : !design ? (
                <p className="px-5 text-sm text-muted-foreground">Loading…</p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-y bg-muted/60 text-left">
                          <th className="px-5 py-2.5">Month</th>
                          <th className="px-5 py-2.5 text-right">
                            Invoiced
                            <span className="block text-xs font-normal text-muted-foreground">issued invoices</span>
                          </th>
                          <th className="px-5 py-2.5 text-right">
                            Quoted
                            <span className="block text-xs font-normal text-muted-foreground">quotations</span>
                          </th>
                          <th className="px-5 py-2.5 text-right">
                            Of quoted, converted
                            <span className="block text-xs font-normal text-muted-foreground">also in invoiced once issued</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {design.months.map((m) => {
                          const current = `${design.year}-${String(m.month).padStart(2, "0")}` === selectedMonth;
                          const empty = m.invoiced.count === 0 && m.quoted.count === 0;
                          return (
                            <tr key={m.month} className={cn("border-b", empty && "text-muted-foreground", current && "bg-primary-soft/40")}>
                              <td className="px-5 py-2.5 font-medium">{m.label}</td>
                              <td className="px-5 py-2.5 text-right">
                                {formatINR(m.invoiced.amount)}
                                {m.invoiced.count > 0 && <span className="ml-1 text-xs text-muted-foreground">({m.invoiced.count})</span>}
                              </td>
                              <td className="px-5 py-2.5 text-right">
                                {formatINR(m.quoted.amount)}
                                {m.quoted.count > 0 && <span className="ml-1 text-xs text-muted-foreground">({m.quoted.count})</span>}
                              </td>
                              <td className="px-5 py-2.5 text-right">{formatINR(m.convertedQuotes.amount)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="font-semibold">
                          <td className="px-5 py-2.5">{design.year} total</td>
                          <td className="px-5 py-2.5 text-right">{formatINR(design.totals.invoiced.amount)}</td>
                          <td className="px-5 py-2.5 text-right">{formatINR(design.totals.quoted.amount)}</td>
                          <td className="px-5 py-2.5 text-right">{formatINR(design.totals.convertedQuotes.amount)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {design.years.length > 1 && (
                    <div className="overflow-x-auto px-5">
                      <h4 className="mb-2 text-sm font-semibold">By year</h4>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-muted-foreground">
                            <th className="py-2 font-medium">Year</th>
                            <th className="py-2 text-right font-medium">Invoiced</th>
                            <th className="py-2 text-right font-medium">Quoted</th>
                          </tr>
                        </thead>
                        <tbody>
                          {design.years.map((y) => (
                            <tr key={y.year} className="border-b last:border-0">
                              <td className="py-2">
                                <button type="button" className="font-medium text-primary-strong hover:underline" onClick={() => setDesignYear(y.year)}>
                                  {y.year}
                                </button>
                              </td>
                              <td className="py-2 text-right">{formatINR(y.invoiced.amount)}</td>
                              <td className="py-2 text-right">{formatINR(y.quoted.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="mx-5 flex items-start gap-2 rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-xs text-info-strong">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-1">
                      <p>
                        <span className="font-semibold">Invoiced:</span> {design.sources.invoiced}
                      </p>
                      <p>
                        <span className="font-semibold">Quoted:</span> {design.sources.quoted}
                      </p>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {hasGst && (
          <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">GST on older invoices, by rate</CardTitle>
              <p className="text-sm text-muted-foreground">From invoices issued with GST before it was removed. New invoices carry none.</p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-y bg-muted/60 text-left">
                      <th className="px-5 py-2.5">Rate</th>
                      <th className="px-5 py-2.5 text-right">Invoices</th>
                      <th className="px-5 py-2.5 text-right">Taxable value</th>
                      <th className="px-5 py-2.5 text-right">GST</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slabs.map(([key, s]) => (
                      <tr key={key} className={cn("border-b last:border-0", s.count === 0 && "text-muted-foreground")}>
                        <td className="px-5 py-2.5 font-medium">{rateOf(key)}%</td>
                        <td className="px-5 py-2.5 text-right">{s.count}</td>
                        <td className="px-5 py-2.5 text-right">{formatINR(s.amount)}</td>
                        <td className="px-5 py-2.5 text-right">{formatINR(s.tax)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="CGST" value={formatINR(reportData.cgstAmount)} hint="Central GST (intra-state)" />
            <StatCard label="SGST" value={formatINR(reportData.sgstAmount)} hint="State GST (intra-state)" />
            <StatCard label="IGST" value={formatINR(reportData.igstAmount)} hint="Integrated GST (inter-state)" />
          </div>
          </>
          )}

          {reportData.excludedNoGst.count > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-sm text-info-strong">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {reportData.excludedNoGst.count} older No GST bill{reportData.excludedNoGst.count === 1 ? "" : "s"} totalling{" "}
                {formatINR(reportData.excludedNoGst.amount)} {reportData.excludedNoGst.count === 1 ? "is" : "are"} not included in these figures.
              </span>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notes to accountant</CardTitle>
              <p className="text-sm text-muted-foreground">Included in the CSV and the email</p>
            </CardHeader>
            <CardContent>
              <Textarea
                value={accountantNotes}
                onChange={(e) => setAccountantNotes(e.target.value)}
                placeholder="Special transactions, adjustments, credit notes to expect…"
                rows={4}
              />
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={emailDialogOpen} onOpenChange={setEmailDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Email report to accountant</DialogTitle>
            <DialogDescription>
              The server rebuilds the {reportData?.month} figures and attaches them as a CSV, with your notes.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              sendEmailToAccountant();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">Accountant's email</Label>
              <Input
                id="email"
                type="email"
                required
                value={emailData.email}
                onChange={(e) => setEmailData((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="accountant@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="subject">Subject</Label>
              <Input id="subject" value={emailData.subject} onChange={(e) => setEmailData((prev) => ({ ...prev, subject: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="message">Message</Label>
              <Textarea id="message" rows={4} value={emailData.message} onChange={(e) => setEmailData((prev) => ({ ...prev, message: e.target.value }))} />
            </div>
            {emailError && (
              <p role="alert" className="rounded-md border border-destructive/25 bg-destructive-soft px-3 py-2 text-sm text-destructive-strong">
                {emailError}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEmailDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={sending} disabled={!emailData.email.trim()}>
                {sending ? "Sending…" : "Send report"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
