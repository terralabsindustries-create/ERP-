import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { Download, FileText, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/common/EmptyState";
import { StatCard } from "@/components/common/StatTile";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/printWorkflow";
import { cn } from "@/lib/utils";

interface CustomerRow {
  customerId: string;
  customerName: string;
  invoiceCount: number;
  draftCount: number;
  totalInvoiced: number;
  paidToDate: number;
  outstanding: number;
}

interface CustomerReportData {
  month: string;
  period: string;
  customers: CustomerRow[];
  totals: Omit<CustomerRow, "customerId" | "customerName">;
  draftCount: number;
}

interface InvoiceRow {
  _id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  totalAmount: number;
  paidAmount?: number;
  balanceAmount?: number;
  status: string;
  paymentStatus: string;
}

interface InvoicePage {
  invoices: InvoiceRow[];
  pagination: { page: number; limit: number; total: number };
}

const csvCell = (value: unknown) => {
  let text = String(value ?? "");
  // Spreadsheet programs interpret these leading characters as formulas.
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const money = (value: number) => formatINR(value || 0);

export function CustomerReport({ month, onMonthChange, canExport }: {
  month: string;
  onMonthChange: (month: string) => void;
  canExport: boolean;
}) {
  const [report, setReport] = useState<CustomerReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<InvoicePage | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient.getCustomerReport(month)
      .then((value) => {
        if (cancelled) return;
        const data = value as CustomerReportData;
        if (!Array.isArray(data?.customers) || !data.totals) throw new Error("The customer report returned an unexpected response.");
        setReport(data);
        setSelectedId((current) => data.customers.some((row) => row.customerId === current)
          ? current : data.customers.length === 1 ? data.customers[0].customerId : null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setReport(null);
        setError(cause instanceof Error ? cause.message : "The customer report could not be loaded.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month, refreshKey]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    apiClient.getCustomerReportInvoices(selectedId, month, page)
      .then((value) => { if (!cancelled) setDetail(value as InvoicePage); })
      .catch((cause) => {
        if (cancelled) return;
        setDetail(null);
        setDetailError(cause instanceof Error ? cause.message : "Customer invoices could not be loaded.");
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, month, page, refreshKey]);

  const rows = useMemo(() => (report?.customers || []).filter((row) =>
    row.customerName.toLowerCase().includes(search.trim().toLowerCase())
  ), [report, search]);
  const selected = report?.customers.find((row) => row.customerId === selectedId);

  const exportCsv = () => {
    if (!report) return;
    const lines: unknown[][] = [
      ["Customer report", report.month],
      ["Drafts shown separately; cancelled and older No GST bills excluded"],
      [],
      ["Customer", "Issued invoices", "Drafts", "Total invoiced", "Paid to date on issued invoices", "Outstanding on issued invoices"],
      ...report.customers.map((row) => [row.customerName, row.invoiceCount, row.draftCount, row.totalInvoiced, row.paidToDate, row.outstanding]),
      ["Total", report.totals.invoiceCount, report.totals.draftCount, report.totals.totalInvoiced, report.totals.paidToDate, report.totals.outstanding]
    ];
    const csv = lines.map((line) => line.map(csvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `customer-report-${month}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle className="text-base">Report period</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="customer-report-month">Month</Label>
            <Input id="customer-report-month" type="month" value={month} onChange={(event) => { onMonthChange(event.target.value); setPage(1); }} className="w-48" />
          </div>
          <div className="relative w-full space-y-1.5 sm:w-64">
            <Label htmlFor="customer-report-search">Customer</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input id="customer-report-search" placeholder="Search customer name" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" />
            </div>
          </div>
          <Button variant="outline" onClick={() => setRefreshKey((key) => key + 1)} loading={loading}>{loading ? "Refreshing…" : "Refresh"}</Button>
          {canExport && <Button variant="outline" onClick={exportCsv} disabled={!report || loading} className="sm:ml-auto"><Download /> Export customer CSV</Button>}
        </CardContent>
      </Card>

      {error && <Card><EmptyState icon={FileText} title="Customer report unavailable" description={error} /></Card>}
      {report && <>
        {report.draftCount > 0 && <div className="rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-sm text-info-strong">
          {report.draftCount} draft invoice{report.draftCount === 1 ? " is" : "s are"} listed separately and excluded from financial totals. <Link to="/invoices?view=draft" className="font-semibold underline underline-offset-2">Review drafts</Link>
        </div>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Customers" value={report.customers.length} hint={`With invoices or drafts in ${report.month}`} />
          <StatCard label="Invoices" value={report.totals.invoiceCount} hint="Issued in the selected month" />
          <StatCard label="Total invoiced" value={money(report.totals.totalInvoiced)} hint="Same invoice basis as the monthly report" />
          <StatCard label="Outstanding" value={money(report.totals.outstanding)} hint="Balance remaining on these invoices" />
        </div>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="text-base">By customer</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Issued totals and current balances for invoices dated {report.month}; drafts are separate.</p>
            </div>
          </CardHeader>
          {rows.length === 0 ? (
            <EmptyState icon={Users} title={search ? "No matching customers" : `No invoices in ${report.month}`} description={search ? "Try another customer name." : "Cancelled and older No GST bills are not included."} />
          ) : (
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[760px] text-sm">
                <thead><tr className="border-y bg-muted/60 text-left text-muted-foreground">
                  <th className="px-5 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 text-right font-medium">Invoices</th>
                  <th className="px-4 py-3 text-right font-medium">Drafts</th>
                  <th className="px-4 py-3 text-right font-medium">Invoiced</th>
                  <th className="px-4 py-3 text-right font-medium">Paid to date</th>
                  <th className="px-5 py-3 text-right font-medium">Outstanding</th>
                </tr></thead>
                <tbody>{rows.map((row) => (
                  <tr key={row.customerId} className={cn("border-b last:border-0", selectedId === row.customerId && "bg-primary-soft/40")}>
                    <td className="px-5 py-3"><button type="button" className="text-left font-medium text-primary hover:underline" onClick={() => { setSelectedId(row.customerId); setPage(1); }}>{row.customerName}</button></td>
                    <td className="px-4 py-3 text-right">{row.invoiceCount}</td>
                    <td className="px-4 py-3 text-right">{row.draftCount}</td>
                    <td className="px-4 py-3 text-right font-medium">{money(row.totalInvoiced)}</td>
                    <td className="px-4 py-3 text-right">{money(row.paidToDate)}</td>
                    <td className="px-5 py-3 text-right">{money(row.outstanding)}</td>
                  </tr>
                ))}</tbody>
                <tfoot><tr className="border-t font-semibold">
                  <td className="px-5 py-3">Total</td>
                  <td className="px-4 py-3 text-right">{report.totals.invoiceCount}</td>
                  <td className="px-4 py-3 text-right">{report.totals.draftCount}</td>
                  <td className="px-4 py-3 text-right">{money(report.totals.totalInvoiced)}</td>
                  <td className="px-4 py-3 text-right">{money(report.totals.paidToDate)}</td>
                  <td className="px-5 py-3 text-right">{money(report.totals.outstanding)}</td>
                </tr></tfoot>
              </table>
            </CardContent>
          )}
        </Card>

        {selected && <Card>
          <CardHeader>
            <CardTitle className="text-base">{selected.customerName} · invoices</CardTitle>
            <p className="text-sm text-muted-foreground">Invoices and drafts dated {report.month}. Select another customer above to switch.</p>
          </CardHeader>
          {detailError ? <p className="px-5 pb-5 text-sm text-destructive-strong">{detailError}</p> : detailLoading ? <p className="px-5 pb-5 text-sm text-muted-foreground">Loading invoices…</p> : detail && <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[740px] text-sm">
              <thead><tr className="border-y bg-muted/60 text-left text-muted-foreground">
                <th className="px-5 py-3 font-medium">Invoice</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Date</th><th className="px-4 py-3 font-medium">Due</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th><th className="px-4 py-3 text-right font-medium">Paid</th><th className="px-5 py-3 text-right font-medium">Balance</th>
              </tr></thead>
              <tbody>{detail.invoices.map((invoice) => <tr key={invoice._id} className="border-b last:border-0">
                <td className="px-5 py-3"><Link to={`/invoices?q=${encodeURIComponent(invoice.invoiceNumber)}`} className="font-medium text-primary hover:underline">{invoice.invoiceNumber}</Link></td>
                <td className="px-4 py-3 capitalize">{invoice.status}</td>
                <td className="px-4 py-3">{format(new Date(invoice.invoiceDate), "dd MMM yyyy")}</td>
                <td className="px-4 py-3">{invoice.dueDate ? format(new Date(invoice.dueDate), "dd MMM yyyy") : "—"}</td>
                <td className="px-4 py-3 text-right">{money(invoice.totalAmount)}</td>
                <td className="px-4 py-3 text-right">{invoice.status === "draft" ? "—" : money(invoice.paidAmount || 0)}</td>
                <td className="px-5 py-3 text-right">{invoice.status === "draft" ? "—" : money(invoice.balanceAmount || 0)}</td>
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
