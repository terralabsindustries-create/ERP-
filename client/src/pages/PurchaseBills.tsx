import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Search, Download, MoreHorizontal, Pencil, Trash2, CheckCircle2, Receipt, Wallet, FileText } from "lucide-react";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { NewPurchaseBillDialog } from "@/components/purchase-bills/NewPurchaseBillDialog";

const statusVariant: Record<string, "success" | "secondary" | "destructive" | "outline"> = {
  paid: "success",
  partial: "secondary",
  pending: "outline",
};

export default function PurchaseBills() {
  const { toast } = useToast();
  const [bills, setBills] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({ totalBills: 0, totalAmount: 0, paidAmount: 0, outstandingAmount: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBill, setEditingBill] = useState<any | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [billsRes, statsRes]: any = await Promise.all([
        apiClient.getPurchaseBills(search ? { search } : undefined),
        apiClient.getPurchaseBillStats(),
      ]);
      // apiClient.request() already unwraps the `data` envelope, so bills/stats
      // live at the top level. Fall back to the nested shape just in case.
      setBills(billsRes?.bills || billsRes?.data?.bills || []);
      setStats(
        statsRes?.stats || statsRes?.data?.stats || { totalBills: 0, totalAmount: 0, paidAmount: 0, outstandingAmount: 0 }
      );
    } catch (error) {
      console.error("Error fetching purchase bills:", error);
      toast({ title: "Error", description: "Failed to fetch purchase bills", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNew = () => {
    setEditingBill(null);
    setDialogOpen(true);
  };

  const handleEdit = (bill: any) => {
    setEditingBill(bill);
    setDialogOpen(true);
  };

  const handleDownload = async (bill: any) => {
    try {
      toast({ title: "Generating PDF", description: `Preparing ${bill.billNumber}...` });
      await apiClient.downloadPurchaseBillPDF(bill._id);
    } catch (error: any) {
      toast({
        title: "Download failed",
        description: error?.message || "Failed to download bill PDF",
        variant: "destructive",
      });
    }
  };

  const handleMarkPaid = async (bill: any) => {
    try {
      await apiClient.updatePurchaseBill(bill._id, { paidAmount: bill.totalAmount });
      toast({ title: "Marked as paid", description: `${bill.billNumber} is fully paid` });
      fetchData();
    } catch (error: any) {
      toast({ title: "Error", description: error?.message || "Failed to update bill", variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await apiClient.deletePurchaseBill(deleteId);
      toast({ title: "Deleted", description: "Purchase bill deleted" });
      setDeleteId(null);
      fetchData();
    } catch (error: any) {
      toast({ title: "Error", description: error?.message || "Failed to delete bill", variant: "destructive" });
    }
  };

  const formatDate = (d?: string) =>
    d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "-";

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Purchase Bills</h1>
          <p className="text-muted-foreground text-sm">Record and track bills received from vendors</p>
        </div>
        <Button className="gap-2" onClick={handleNew}>
          <Plus className="w-4 h-4" />
          New Purchase Bill
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <FileText className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Bills</p>
              <p className="text-xl font-bold">{stats.totalBills || 0}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Wallet className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Paid</p>
              <p className="text-xl font-bold text-success">{formatCurrency(stats.paidAmount || 0)}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Receipt className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Outstanding</p>
              <p className="text-xl font-bold text-warning">{formatCurrency(stats.outstandingAmount || 0)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          fetchData();
        }}
        className="flex items-center gap-2"
      >
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search bill #, vendor, invoice #"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {/* Bills Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">All Bills</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
              Loading purchase bills...
            </div>
          ) : bills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <FileText className="h-10 w-10 text-muted-foreground opacity-40" />
              <h3 className="text-lg font-semibold">No purchase bills yet</h3>
              <p className="text-muted-foreground text-sm max-w-sm">
                Click "New Purchase Bill" to record one.
              </p>
              <Button onClick={handleNew} className="gap-2">
                <Plus className="h-4 w-4" />
                New Purchase Bill
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">Bill #</th>
                    <th className="text-left px-4 py-3 font-medium">Vendor</th>
                    <th className="text-left px-4 py-3 font-medium">Vendor Inv #</th>
                    <th className="text-left px-4 py-3 font-medium">Date</th>
                    <th className="text-left px-4 py-3 font-medium">Total</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => (
                    <tr key={bill._id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium">{bill.billNumber}</td>
                      <td className="px-4 py-3">{bill.vendorName}</td>
                      <td className="px-4 py-3 text-muted-foreground">{bill.vendorInvoiceNumber || "-"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(bill.billDate)}</td>
                      <td className="px-4 py-3 font-medium">{formatCurrency(bill.totalAmount || 0)}</td>
                      <td className="px-4 py-3">
                        <Badge variant={statusVariant[bill.paymentStatus] || "outline"} className="capitalize">
                          {bill.paymentStatus}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleDownload(bill)}>
                              <Download className="h-4 w-4 mr-2" /> Download PDF
                            </DropdownMenuItem>
                            {bill.paymentStatus !== "paid" && (
                              <DropdownMenuItem onClick={() => handleMarkPaid(bill)}>
                                <CheckCircle2 className="h-4 w-4 mr-2" /> Mark Paid
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => handleEdit(bill)}>
                              <Pencil className="h-4 w-4 mr-2" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteId(bill._id)}>
                              <Trash2 className="h-4 w-4 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <NewPurchaseBillDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={fetchData}
        bill={editingBill}
      />

      <AlertDialog open={Boolean(deleteId)} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete purchase bill?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The bill will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
