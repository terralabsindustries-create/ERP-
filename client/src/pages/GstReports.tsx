import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { DataCard, MetricBar, StatusPill, ViewTabs, type Metric } from "@/components/data";
import { ErrorState, StaleDataBanner } from "@/components/common/LoadState";
import { EmptyState } from "@/components/common/EmptyState";
import { useLoader } from "@/hooks/useLoader";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR } from "@/lib/format";
import { financialYearLabel } from "@/lib/gstPeriods";

/*
  GST working papers (backend services/gstReports.js): GSTR-1 sections,
  GSTR-3B summary, registers and validation, for a month, quarter or year.
  It is a report to prepare and check a return — not a filing.
*/

type Mode = "month" | "quarter" | "fy";
type Section = "b2b" | "b2cl" | "b2cs" | "cdnr" | "cdnur" | "hsnB2B" | "hsnB2C" | "docs" | "sales" | "purchases" | "notes" | "warnings";

const COLUMNS: Record<Section, { key: string; label: string; money?: boolean; date?: boolean }[]> = {
  b2b: [{ key: "gstin", label: "GSTIN" }, { key: "receiverName", label: "Receiver" }, { key: "invoiceNumber", label: "Invoice" }, { key: "invoiceDate", label: "Date", date: true }, { key: "placeOfSupply", label: "Place of supply" }, { key: "rate", label: "Rate %" }, { key: "taxable", label: "Taxable", money: true }, { key: "igst", label: "IGST", money: true }, { key: "cgst", label: "CGST", money: true }, { key: "sgst", label: "SGST", money: true }],
  b2cl: [{ key: "invoiceNumber", label: "Invoice" }, { key: "invoiceDate", label: "Date", date: true }, { key: "invoiceValue", label: "Value", money: true }, { key: "placeOfSupply", label: "Place of supply" }, { key: "rate", label: "Rate %" }, { key: "taxable", label: "Taxable", money: true }, { key: "igst", label: "IGST", money: true }],
  b2cs: [{ key: "placeOfSupply", label: "Place of supply" }, { key: "supplyType", label: "Type" }, { key: "rate", label: "Rate %" }, { key: "taxable", label: "Taxable", money: true }, { key: "igst", label: "IGST", money: true }, { key: "cgst", label: "CGST", money: true }, { key: "sgst", label: "SGST", money: true }],
  cdnr: [{ key: "gstin", label: "GSTIN" }, { key: "noteNumber", label: "Note" }, { key: "noteType", label: "C/D" }, { key: "noteDate", label: "Date", date: true }, { key: "originalInvoice", label: "Invoice" }, { key: "rate", label: "Rate %" }, { key: "taxable", label: "Taxable", money: true }, { key: "igst", label: "IGST", money: true }, { key: "cgst", label: "CGST", money: true }, { key: "sgst", label: "SGST", money: true }],
  cdnur: [{ key: "noteNumber", label: "Note" }, { key: "noteType", label: "C/D" }, { key: "noteDate", label: "Date", date: true }, { key: "originalInvoice", label: "Invoice" }, { key: "placeOfSupply", label: "Place of supply" }, { key: "rate", label: "Rate %" }, { key: "taxable", label: "Taxable", money: true }, { key: "igst", label: "IGST", money: true }],
  hsnB2B: [{ key: "hsn", label: "HSN/SAC" }, { key: "description", label: "Description" }, { key: "uqc", label: "UQC" }, { key: "quantity", label: "Qty" }, { key: "rate", label: "Rate %" }, { key: "taxable", label: "Taxable", money: true }, { key: "igst", label: "IGST", money: true }, { key: "cgst", label: "CGST", money: true }, { key: "sgst", label: "SGST", money: true }],
  hsnB2C: [{ key: "hsn", label: "HSN/SAC" }, { key: "description", label: "Description" }, { key: "uqc", label: "UQC" }, { key: "quantity", label: "Qty" }, { key: "rate", label: "Rate %" }, { key: "taxable", label: "Taxable", money: true }, { key: "igst", label: "IGST", money: true }, { key: "cgst", label: "CGST", money: true }, { key: "sgst", label: "SGST", money: true }],
  docs: [{ key: "nature", label: "Document" }, { key: "from", label: "From" }, { key: "to", label: "To" }, { key: "total", label: "Total" }, { key: "cancelled", label: "Cancelled" }, { key: "net", label: "Net issued" }],
  sales: [{ key: "invoiceNumber", label: "Invoice" }, { key: "invoiceDate", label: "Date", date: true }, { key: "customerName", label: "Customer" }, { key: "customerGstin", label: "GSTIN" }, { key: "placeOfSupply", label: "Place of supply" }, { key: "invoiceValue", label: "Value", money: true }, { key: "taxable", label: "Taxable", money: true }, { key: "totalTax", label: "Tax", money: true }],
  purchases: [{ key: "billNumber", label: "Bill" }, { key: "billDate", label: "Date", date: true }, { key: "supplierName", label: "Supplier" }, { key: "supplierGstin", label: "GSTIN" }, { key: "taxable", label: "Taxable", money: true }, { key: "igst", label: "IGST", money: true }, { key: "cgst", label: "CGST", money: true }, { key: "sgst", label: "SGST", money: true }],
  notes: [{ key: "noteNumber", label: "Note" }, { key: "noteType", label: "C/D" }, { key: "noteDate", label: "Date", date: true }, { key: "invoiceNumber", label: "Invoice" }, { key: "customerName", label: "Customer" }, { key: "section", label: "Reported in" }, { key: "taxable", label: "Taxable", money: true }, { key: "noteValue", label: "Value", money: true }],
  warnings: [{ key: "code", label: "Check" }, { key: "message", label: "Detail" }],
};

const TABS: { value: Section; label: string }[] = [
  { value: "b2b", label: "B2B" }, { value: "b2cl", label: "B2CL" }, { value: "b2cs", label: "B2CS" }, { value: "cdnr", label: "CDNR" },
  { value: "cdnur", label: "CDNUR" }, { value: "hsnB2B", label: "HSN B2B" }, { value: "hsnB2C", label: "HSN B2C" }, { value: "docs", label: "Docs (13)" },
  { value: "sales", label: "Sales register" }, { value: "purchases", label: "Purchases" }, { value: "notes", label: "Notes" }, { value: "warnings", label: "Validation" },
];

const thisMonth = () => new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 7);

function ComplianceSettings() {
  const { toast } = useToast();
  const cfg = useLoader((signal) => apiClient.getWithSignal<{ settings: any }>("/gst-compliance/settings", undefined, signal), []);
  const s = cfg.data?.settings;
  const [threshold, setThreshold] = useState<string>("");
  const save = async (patch: Record<string, unknown>) => {
    try {
      await apiClient.put("/gst-compliance/settings", patch);
      cfg.reload();
      toast({ title: "Compliance settings saved" });
    } catch (error) {
      toast({ title: "Not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };
  if (!s) return null;
  return (
    <details className="rounded-xl border bg-card p-4 text-sm shadow-card">
      <summary className="cursor-pointer font-medium">Compliance settings — e-invoice & e-way bill</summary>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!s.eInvoiceEnabled} onChange={(e) => save({ eInvoiceEnabled: e.target.checked })} />E-invoicing applies to my business</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!s.eWayBillEnabled} onChange={(e) => save({ eWayBillEnabled: e.target.checked })} />Generate e-way bills</label>
        <label className="text-xs text-muted-foreground">E-way bill value limit (₹)
          <Input className="mt-1 h-8 w-[140px]" type="number" min={0} placeholder={s.eWayBillThreshold != null ? String(s.eWayBillThreshold) : "Not set"} value={threshold} onChange={(e) => setThreshold(e.target.value)} onBlur={() => threshold !== "" && save({ eWayBillThreshold: Number(threshold) })} />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Provider: {s.provider === "none" ? "none connected — IRNs and e-way bills cannot be generated until an authorised GSP is set up" : s.provider} ({s.environment}).
        The e-way bill limit is the consignment value your state requires one from (commonly ₹50,000 under CGST Rule 138; some states differ) — confirm it before relying on it.
      </p>
    </details>
  );
}

export default function GstReports() {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("month");
  const [month, setMonth] = useState(thisMonth());
  const [fy, setFy] = useState(financialYearLabel(new Date()));
  const [quarter, setQuarter] = useState("3");
  const [section, setSection] = useState<Section>("b2b");

  const query = useMemo(() => (mode === "month" ? { month } : mode === "quarter" ? { quarter: fy, q: quarter } : { fy }), [mode, month, fy, quarter]);
  const qs = new URLSearchParams(query as Record<string, string>).toString();
  const report = useLoader((signal) => apiClient.getWithSignal<any>("/gst-reports", query, signal), [qs]);
  const r = report.data;

  const rows: any[] = useMemo(() => {
    if (!r) return [];
    const map: Record<Section, any[]> = {
      b2b: r.gstr1.b2b, b2cl: r.gstr1.b2cl, b2cs: r.gstr1.b2cs, cdnr: r.gstr1.cdnr, cdnur: r.gstr1.cdnur, hsnB2B: r.gstr1.hsnB2B,
      hsnB2C: r.gstr1.hsnB2C, docs: r.gstr1.docs, sales: r.registers.sales, purchases: r.registers.purchases, notes: r.registers.notes, warnings: r.warnings,
    };
    return map[section] || [];
  }, [r, section]);

  const download = async (format: "xlsx" | "csv") => {
    try {
      await apiClient.downloadExport(`/gst-reports/export?${qs}&format=${format}${format === "csv" ? `&section=${section}` : ""}`, `GST_${format === "csv" ? section : "report"}.${format}`);
    } catch (error) {
      toast({ title: "Export failed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const g3 = r?.gstr3b;
  const metrics: Metric[] = g3
    ? [
        { label: "Taxable outward (3.1a)", value: formatINR(g3.outwardTaxable.taxable, { compact: g3.outwardTaxable.taxable >= 1e5 }), hint: `IGST ${formatINR(g3.outwardTaxable.igst)} · CGST ${formatINR(g3.outwardTaxable.cgst)} · SGST ${formatINR(g3.outwardTaxable.sgst)}` },
        { label: "Nil / exempt (3.1c)", value: formatINR(g3.nilExempt.taxable) },
        { label: "Eligible ITC (4)", value: formatINR(g3.eligibleItc.igst + g3.eligibleItc.cgst + g3.eligibleItc.sgst), hint: `IGST ${formatINR(g3.eligibleItc.igst)} · CGST ${formatINR(g3.eligibleItc.cgst)} · SGST ${formatINR(g3.eligibleItc.sgst)}` },
        { label: "Output less ITC", value: formatINR(g3.netPayable.igst + g3.netPayable.cgst + g3.netPayable.sgst), hint: "Before set-off order", tone: "warning" },
      ]
    : [];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Billing & finance"
        title="GST returns"
        description="GSTR-1 sections, GSTR-3B summary and registers from your issued invoices, notes and purchase bills. A working paper to check before you file — not a filing."
        actions={
          <>
            <Button variant="outline" onClick={() => download("csv")} disabled={!r}><Download />CSV ({TABS.find((t) => t.value === section)?.label})</Button>
            <Button onClick={() => download("xlsx")} disabled={!r}><FileSpreadsheet />Excel workbook</Button>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-2">
        <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <SelectTrigger className="w-[150px]" aria-label="Return period type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="month">Monthly</SelectItem>
            <SelectItem value="quarter">Quarterly</SelectItem>
            <SelectItem value="fy">Financial year</SelectItem>
          </SelectContent>
        </Select>
        {mode === "month" ? (
          <Input type="month" aria-label="Return month" className="w-[170px]" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        ) : (
          <Input aria-label="Financial year (e.g. 2026-27)" className="w-[120px]" value={fy} onChange={(e) => setFy(e.target.value)} placeholder="2026-27" />
        )}
        {mode === "quarter" && (
          <Select value={quarter} onValueChange={setQuarter}>
            <SelectTrigger className="w-[160px]" aria-label="Quarter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Q1 Apr–Jun</SelectItem>
              <SelectItem value="2">Q2 Jul–Sep</SelectItem>
              <SelectItem value="3">Q3 Oct–Dec</SelectItem>
              <SelectItem value="4">Q4 Jan–Mar</SelectItem>
            </SelectContent>
          </Select>
        )}
        {r && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-sm">
            {r.reconciliation.balanced ? <CheckCircle2 className="h-4 w-4 text-success-strong" /> : <AlertTriangle className="h-4 w-4 text-warning-strong" />}
            {r.reconciliation.balanced ? "Sections reconcile with the registers" : "Sections do not reconcile — see Validation"}
            {r.warnings.length > 0 && <StatusPill tone="warning" className="ml-1">{r.warnings.length} to check</StatusPill>}
          </span>
        )}
      </div>

      <ComplianceSettings />
      {report.error && r && <StaleDataBanner error={report.error} onRetry={report.reload} updatedAt={report.updatedAt} />}
      {report.error && !r ? (
        <ErrorState error={report.error} what="the GST report" onRetry={report.reload} />
      ) : (
        <>
          <MetricBar metrics={metrics} loading={report.isLoading} />
          <ViewTabs<Section> value={section} onChange={setSection} tabs={TABS.map((t) => ({ ...t, count: r ? (t.value === "warnings" ? r.warnings.length : undefined) : undefined }))} />
          <DataCard footer={r && <span>{r.disclaimer}</span>}>
            {report.isLoading ? (
              <div className="space-y-2 p-4" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-9 animate-pulse rounded bg-muted" />)}</div>
            ) : rows.length === 0 ? (
              <EmptyState compact title={section === "warnings" ? "No problems found" : "Nothing in this section for the period"} tone={section === "warnings" ? "success" : "default"} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
                      {COLUMNS[section].map((c) => <th key={c.key} className={`h-10 px-3 font-semibold ${c.money ? "text-right" : ""}`}>{c.label}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((row, i) => (
                      <tr key={i}>
                        {COLUMNS[section].map((c) => (
                          <td key={c.key} className={`px-3 py-2 ${c.money ? "num text-right font-mono" : ""}`}>
                            {c.money ? formatINR(Number(row[c.key]) || 0) : c.date ? fmtDate(row[c.key]) : String(row[c.key] ?? "—")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DataCard>
        </>
      )}
    </PageShell>
  );
}
