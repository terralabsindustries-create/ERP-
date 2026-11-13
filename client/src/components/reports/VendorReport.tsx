import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { Download, FileText, Search, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/common/EmptyState";
import { StatCard } from "@/components/common/StatTile";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/printWorkflow";
import { cn } from "@/lib/utils";

interface VendorRow {
  vendorId: string;
  vendorName: string;
  billCount: number;
  draftCount: number;
  taxableAmount: number;
  gstAmount: number;
  totalBilled: number;
  paidToDate: number;
  outstanding: number;
}

/** GET /api/reports/vendors — see backend/src/routes/reports.js. */
interface VendorReportData {
  month: string;
  period: string;
  vendors: VendorRow[];
  totals: Omit<VendorRow, "vendorId" | "vendorName">;
  draftCount: number;
}

interface BillRow {
  _id: string;
  billNumber: string;
  vendorInvoiceNumber?: string;
  billDate: string;
  dueDate?: string;
  totalAmount: number;
  paidAmount?: number;
  balanceAmount?: number;
  status: string;
  paymentStatus: string;
}

interface BillPage {
  bills: BillRow[];
  pagination: { page: number; limit: number; total: number };
}

const csvCell = (value: unknown) => {
  let text = String(value ?? "");
  // Spreadsheet programs interpret these leading characters as formulas.
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const money = (value: number) => formatINR(value || 0);

export function VendorReport({ month, onMonthChange, canExport }: {
  month: string;
  onMonthChange: (month: string) => void;
  canExport: boolean;
}) {
  const [report, setReport] = useState<VendorReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<BillPage | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient.getVendorReport(month)
      .then((value) => {
        if (cancelled) return;
        const data = value as VendorReportData;
        if (!Array.isArray(data?.vendors) || !data.totals) throw new Error("The vendor report returned an unexpected response.");
        setReport(data);
        setSelectedId((current) => data.vendors.some((row) => row.vendorId === current)
          ? current : data.vendors.length === 1 ? data.vendors[0].vendorId : null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setReport(null);
        setError(cause instanceof Error ? cause.message : "The vendor report could not be loaded.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month, refreshKey]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    apiClient.getVendorReportBills(selectedId, month, page)
      .then((value) => { if (!cancelled) setDetail(value as BillPage); })
      .catch((cause) => {
        if (cancelled) return;
        setDetail(null);
        setDetailError(cause instanceof Error ? cause.message : "Vendor bills could not be loaded.");
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, month, page, refreshKey]);

  const rows = useMemo(() => (report?.vendors || []).filter((row) =>
    row.vendorName.toLowerCase().includes(search.trim().toLowerCase())
  ), [report, search]);
  const selected = report?.vendors.find((row) => row.vendorId === selectedId);

  const exportCsv = () => {
    if (!report) return;
    const t = report.totals;
    const lines: unknown[][] = [
      ["Vendor report", report.month],
      ["Purchase bills by bill date; drafts shown separately; cancelled bills excluded"],
      [],
      ["Vendor", "Recorded bills", "Drafts", "Taxable value", "GST", "Total billed", "Paid to date", "Outstanding"],
      ...report.vendors.map((row) => [row.vendorName, row.billCount, row.draftCount, row.taxableAmount, row.gstAmount, row.totalBilled, row.paidToDate, row.outstanding]),
      ["Total", t.billCount, t.draftCount, t.taxableAmount, t.gstAmount, t.totalBilled, t.paidToDate, t.outstanding]
    ];
    const csv = lines.map((line) => line.map(csvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `vendor-report-${month}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle className="text-base">Report period</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="vendor-report-month">Month</Label>
            <Input id="vendor-report-month" type="month" value={month} onChange={(event) => { onMonthChange(event.target.value); setPage(1); }} className="w-48" />
          </div>
          <div className="relative w-full space-y-1.5 sm:w-64">
            <Label htmlFor="vendor-report-search">Vendor</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input id="vendor-report-search" placeholder="Search vendor name" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" />
            </div>
          </div>
          <Button variant="outline" onClick={() => setRefreshKey((key) => key + 1)} loading={loading}>{loading ? "Refreshing…" : "Refresh"}</Button>
          {canExport && <Button variant="outline" onClick={exportCsv} disabled={!report || loading} className="sm:ml-auto"><Download /> Export vendor CSV</Button>}
        </CardContent>
      </Card>

      {error && <Card><EmptyState icon={FileText} title="Vendor report unavailable" description={error} /></Card>}
      {report && <>
        {report.draftCount > 0 && <div className="rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-sm text-info-strong">
          {report.draftCount} draft bill{report.draftCount === 1 ? " is" : "s are"} listed separately and excluded from the totals.
        </div>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Vendors" value={report.vendors.length} hint={`With bills or drafts in ${report.month}`} />
          <StatCard label="Bills" value={report.totals.billCount} hint="Recorded in the selected month" />
          <StatCard label="Total billed" value={money(report.totals.totalBilled)} hint={report.totals.gstAmount > 0 ? `Includes ${money(report.totals.gstAmount)} GST` : "No GST on these bills"} />
          <StatCard label="Outstanding" value={money(report.totals.outstanding)} hint="Still to pay on these bills" />
        </div>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="text-base">By vendor</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Purchase bill totals and current balances for bills dated {report.month}; drafts are separate.</p>
            </div>
          </CardHeader>
          {rows.length === 0 ? (
            <EmptyState icon={Truck} title={search ? "No matching vendors" : `No purchase bills in ${report.month}`} description={search ? "Try another vendor name." : "Cancelled bills are not included."} />
          ) : (
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[860px] text-sm">
                <thead><tr className="border-y bg-muted/60 text-left text-muted-foreground">
                  <th className="px-5 py-3 font-medium">Vendor</th>
                  <th className="px-4 py-3 text-right font-medium">Bills</th>
                  <th className="px-4 py-3 text-right font-medium">Drafts</th>
                  <th className="px-4 py-3 text-right font-medium">Taxable</th>
                  <th className="px-4 py-3 text-right font-medium">GST</th>
                  <th className="px-4 py-3 text-right font-medium">Billed</th>
                  <th className="px-4 py-3 text-right font-medium">Paid to date</th>
                  <th className="px-5 py-3 text-right font-medium">Outstanding</th>
                </tr></thead>
                <tbody>{rows.map((row) => (
                  <tr key={row.vendorId} className={cn("border-b last:border-0", selectedId === row.vendorId && "bg-primary-soft/40")}>
                    <td className="px-5 py-3"><button type="button" className="text-left font-medium text-primary hover:underline" onClick={() => { setSelectedId(row.vendorId); setPage(1); }}>{row.vendorName}</button></td>
                    <td className="px-4 py-3 text-right">{row.billCount}</td>
                    <td className="px-4 py-3 text-right">{row.draftCount}</td>
                    <td className="px-4 py-3 text-right">{money(row.taxableAmount)}</td>
                    <td className="px-4 py-3 text-right">{money(row.gstAmount)}</td>
                    <td className="px-4 py-3 text-right font-medium">{money(row.totalBilled)}</td>
                    <td className="px-4 py-3 text-right">{money(row.paidToDate)}</td>
                    <td className="px-5 py-3 text-right">{money(row.outstanding)}</td>
                  </tr>
                ))}</tbody>
                <tfoot><tr className="border-t font-semibold">
                  <td className="px-5 py-3">Total</td>
                  <td className="px-4 py-3 text-right">{report.totals.billCount}</td>
                  <td className="px-4 py-3 text-right">{report.totals.draftCount}</td>
                  <td className="px-4 py-3 text-right">{money(report.totals.taxableAmount)}</td>
                  <td className="px-4 py-3 text-right">{money(report.totals.gstAmount)}</td>
                  <td className="px-4 py-3 text-right">{money(report.totals.totalBilled)}</td>
                  <td className="px-4 py-3 text-right">{money(report.totals.paidToDate)}</td>
                  <td className="px-5 py-3 text-right">{money(report.totals.outstanding)}</td>
                </tr></tfoot>
              </table>
            </CardContent>
          )}
        </Card>

        {selected && <Card>
          <CardHeader>
            <CardTitle className="text-base">{selected.vendorName} · bills</CardTitle>
            <p className="text-sm text-muted-foreground">
              Bills and drafts dated {report.month}. <Link to={`/purchase-bills?vendor=${encodeURIComponent(selected.vendorId)}`} className="font-medium text-primary hover:underline">Open in Purchase Bills</Link>
            </p>
          </CardHeader>
          {detailError ? <p className="px-5 pb-5 text-sm text-destructive-strong">{detailError}</p> : detailLoading ? <p className="px-5 pb-5 text-sm text-muted-foreground">Loading bills…</p> : detail && <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[780px] text-sm">
              <thead><tr className="border-y bg-muted/60 text-left text-muted-foreground">
                <th className="px-5 py-3 font-medium">Bill</th><th className="px-4 py-3 font-medium">Vendor ref</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Date</th><th className="px-4 py-3 font-medium">Due</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th><th className="px-4 py-3 text-right font-medium">Paid</th><th className="px-5 py-3 text-right font-medium">Balance</th>
              </tr></thead>
              <tbody>{detail.bills.map((bill) => <tr key={bill._id} className="border-b last:border-0">
                <td className="px-5 py-3 font-medium">{bill.billNumber}</td>
                <td className="px-4 py-3">{bill.vendorInvoiceNumber || "—"}</td>
                <td className="px-4 py-3 capitalize">{bill.status === "draft" ? "draft" : bill.paymentStatus === "pending" ? "unpaid" : bill.paymentStatus}</td>
                <td className="px-4 py-3">{format(new Date(bill.billDate), "dd MMM yyyy")}</td>
                <td className="px-4 py-3">{bill.dueDate ? format(new Date(bill.dueDate), "dd MMM yyyy") : "—"}</td>
                <td className="px-4 py-3 text-right">{money(bill.totalAmount)}</td>
                <td className="px-4 py-3 text-right">{bill.status === "draft" ? "—" : money(bill.paidAmount || 0)}</td>
                <td className="px-5 py-3 text-right">{bill.status === "draft" ? "—" : money(bill.balanceAmount || 0)}</td>
              </tr>)}</tbody>
            </table>
            {detail.pagination.total > detail.pagination.limit && <div className="flex items-center justify-between border-t px-5 py-3 text-sm">
              <span>Page {detail.pagination.page} of {Math.ceil(detail.pagination.total / detail.pagination.limit)}</span>
              <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page * detail.pagination.limit >= detail.pagination.total} onClick={() => setPage((value) => value + 1)}>Next</Button></div>
            </div>}
          </CardContent>}
        </Card>}
      </>}
    </div>
  );
}
