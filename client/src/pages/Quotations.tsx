import { useState, useEffect } from "react";
import { Plus, Search, FileText, Eye, Trash2, Clock, CheckCircle, XCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreateQuotationDialog } from "@/components/quotations/CreateQuotationDialog";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";

interface Quotation {
  _id: string;
  quotationNumber: string;
  customer_id: { _id: string; name: string; email?: string; phone?: string };
  gst_type: "gst" | "non_gst";
  is_interstate: boolean;
  valid_until: string;
  status: "draft" | "sent" | "approved" | "rejected";
  total_amount: number;
  createdAt: string;
  notes?: string;
}

const statusConfig = {
  draft: { label: "Draft", variant: "secondary" as const, icon: Clock },
  sent: { label: "Sent", variant: "default" as const, icon: Send },
  approved: { label: "Approved", variant: "default" as const, icon: CheckCircle },
  rejected: { label: "Rejected", variant: "destructive" as const, icon: XCircle },
};

export default function Quotations() {
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const { toast } = useToast();

  const fetchQuotations = async () => {
    setLoading(true);
    try {
      const response = await apiClient.getQuotations();
      const data = (response as any)?.quotations || (response as any) || [];
      setQuotations(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Error fetching quotations:", error);
      toast({
        title: "Error",
        description: "Failed to fetch quotations",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchQuotations();
  }, []);

  const filtered = quotations.filter((q) => {
    const query = searchQuery.toLowerCase();
    return (
      q.quotationNumber?.toLowerCase().includes(query) ||
      q.customer_id?.name?.toLowerCase().includes(query)
    );
  });

  const formatDate = (dateStr: string) =>
    dateStr ? new Date(dateStr).toLocaleDateString("en-IN") : "-";

  const formatAmount = (amount: number) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(amount ?? 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Quotations</h1>
          <p className="text-muted-foreground text-sm">Manage and track all customer quotations</p>
        </div>
        <CreateQuotationDialog onQuotationCreated={fetchQuotations}>
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            New Quotation
          </Button>
        </CreateQuotationDialog>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(["draft", "sent", "approved", "rejected"] as const).map((status) => {
          const count = quotations.filter((q) => q.status === status).length;
          const cfg = statusConfig[status];
          const Icon = cfg.icon;
          return (
            <Card key={status}>
              <CardContent className="p-4 flex items-center gap-3">
                <Icon className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground capitalize">{cfg.label}</p>
                  <p className="text-xl font-bold">{count}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search by number or customer..."
          className="pl-9"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">All Quotations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
              Loading quotations...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <FileText className="w-10 h-10 opacity-40" />
              <p className="text-sm">
                {searchQuery ? "No quotations match your search." : "No quotations yet. Create your first one."}
              </p>
              {!searchQuery && (
                <CreateQuotationDialog onQuotationCreated={fetchQuotations}>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Plus className="w-4 h-4" />
                    New Quotation
                  </Button>
                </CreateQuotationDialog>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">Quotation #</th>
                    <th className="text-left px-4 py-3 font-medium">Customer</th>
                    <th className="text-left px-4 py-3 font-medium">GST Type</th>
                    <th className="text-left px-4 py-3 font-medium">Valid Until</th>
                    <th className="text-left px-4 py-3 font-medium">Amount</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((q) => {
                    const cfg = statusConfig[q.status] ?? statusConfig.draft;
                    const Icon = cfg.icon;
                    return (
                      <tr key={q._id} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 font-mono">{q.quotationNumber}</td>
                        <td className="px-4 py-3">{q.customer_id?.name ?? "-"}</td>
                        <td className="px-4 py-3">
                          <Badge variant="outline">
                            {q.gst_type === "gst"
                              ? `GST (${q.is_interstate ? "Interstate" : "Intrastate"})`
                              : "Non-GST"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">{formatDate(q.valid_until)}</td>
                        <td className="px-4 py-3 font-medium">{formatAmount(q.total_amount)}</td>
                        <td className="px-4 py-3">
                          <Badge variant={cfg.variant} className="gap-1">
                            <Icon className="w-3 h-3" />
                            {cfg.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{formatDate(q.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
