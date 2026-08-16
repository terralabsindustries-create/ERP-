import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Search, FileText, Download, Eye, Trash2, DollarSign, MoreHorizontal, CheckCircle, Clock, AlertCircle, AlertTriangle, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdvancedCreateInvoiceDialog } from "@/components/invoices/AdvancedCreateInvoiceDialog";
import { ViewInvoiceDialog } from "@/components/invoices/ViewInvoiceDialog";
import { EditInvoiceDialog } from "@/components/invoices/EditInvoiceDialog";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";

interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: {
    _id: string;
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    gstNumber?: string;
  };
  jobId?: {
    _id: string;
    title: string;
  };
  invoiceDate: string;
  dueDate: string;
  items: Array<{
    itemName: string;
    quantity: number;
    unitPrice: number;
    totalAmount: number;
    hsnCode: string;
    gstRate: number;
    gstAmount: number;
    itemTotal: number;
  }>;
  subtotal: number;
  discountAmount: number;
  taxableAmount: number;
  totalGstAmount: number;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled' | 'refunded';
  paymentStatus: 'pending' | 'partial' | 'paid' | 'overdue';
  isInterState: boolean;
  noGst: boolean;
  createdAt: string;
  updatedAt: string;
}

// Helper function to safely parse and validate amounts
const safeParseAmount = (value: string): number | null => {
  try {
    if (value === '' || value === undefined) return null;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  } catch (e) {
    return null;
  }
};

export default function Invoices() {
  const [searchParams] = useSearchParams();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("q") || "");
  const [statusFilter, setStatusFilter] = useState("all");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("all");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showViewDialog, setShowViewDialog] = useState(false);
  const [showPaymentStatusDialog, setShowPaymentStatusDialog] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [paymentStatusData, setPaymentStatusData] = useState({
    paymentStatus: '',
    amountPaid: ''
  });
  const [paymentStatusLoading, setPaymentStatusLoading] = useState(false);
  const [stats, setStats] = useState({
    totalInvoices: 0,
    totalAmount: 0,
    paidAmount: 0,
    pendingAmount: 0,
    avgInvoiceValue: 0
  });
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [invoiceToDelete, setInvoiceToDelete] = useState<string | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [invoiceToEdit, setInvoiceToEdit] = useState<Invoice | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    fetchInvoices();
    fetchStats();
  }, []);

  const fetchInvoices = async () => {
    try {
      // Every invoice is listed here. No-GST invoices are no longer hidden —
      // they are shown with a "No GST" badge instead.
      const response = await apiClient.getInvoices();
      console.log('📄 Invoices response:', response);
      // Sort invoices by creation date (newest first)
      const sortedInvoices = (response.invoices || []).sort((a, b) => {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      setInvoices(sortedInvoices);
    } catch (error) {
      console.error('Error fetching invoices:', error);
      toast({
        title: "Error",
        description: "Failed to fetch invoices",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await apiClient.getInvoiceStats();
      console.log('📊 Invoice stats:', response);
      setStats(response.stats || {
        totalInvoices: 0,
        totalAmount: 0,
        paidAmount: 0,
        pendingAmount: 0,
        avgInvoiceValue: 0
      });
    } catch (error) {
      console.error('Error fetching invoice stats:', error);
    }
  };

  const filteredInvoices = invoices.filter(invoice => {
    const matchesSearch = 
      invoice.invoiceNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      invoice.customerId.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (invoice.jobId?.title || '').toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesPaymentStatus = paymentStatusFilter === "all" || invoice.paymentStatus === paymentStatusFilter;
    const matchesStatus = statusFilter === "all" || invoice.status === statusFilter;

    return matchesSearch && matchesPaymentStatus && matchesStatus;
  });

  const handleViewInvoice = (invoice: Invoice) => {
    setSelectedInvoice(invoice);
    setShowViewDialog(true);
  };

  const handlePaymentStatusClick = (invoice: Invoice) => {
    setSelectedInvoice(invoice);
    setPaymentStatusData({
      paymentStatus: invoice.paymentStatus || 'pending',
      amountPaid: invoice.amountPaid > 0 ? invoice.amountPaid.toString() : ''
    });
    setShowPaymentStatusDialog(true);
  };

  const handleUpdatePaymentStatus = async () => {
    if (!selectedInvoice || !paymentStatusData.paymentStatus) return;

    // Validate amount paid
    if (paymentStatusData.amountPaid !== '') {
      const amountPaid = safeParseAmount(paymentStatusData.amountPaid as string);
      const totalAmount = selectedInvoice.totalAmount || 0;

      if (amountPaid === null) {
        toast({
          title: "Invalid Amount",
          description: "Please enter a valid amount number",
          variant: "destructive",
        });
        return;
      }

      if (amountPaid < 0) {
        toast({
          title: "Invalid Amount",
          description: "Amount paid cannot be negative",
          variant: "destructive",
        });
        return;
      }

      if (amountPaid > totalAmount) {
        const excessAmount = amountPaid - totalAmount;
        toast({
          title: "Amount Exceeds Invoice Total",
          description: `You entered ₹${amountPaid.toLocaleString()}, but the invoice total is only ₹${totalAmount.toLocaleString()}. You exceeded by ₹${excessAmount.toLocaleString()}. Please enter an amount less than or equal to ₹${totalAmount.toLocaleString()}`,
          variant: "destructive",
        });
        return;
      }
    }

    setPaymentStatusLoading(true);
    try {
      const invoiceId = selectedInvoice._id || selectedInvoice.id;
      const updateData: any = {
        paymentStatus: paymentStatusData.paymentStatus
      };

      // Only include amountPaid if it's provided
      if (paymentStatusData.amountPaid !== '') {
        const parsedAmount = safeParseAmount(paymentStatusData.amountPaid as string);
        if (parsedAmount !== null) {
          updateData.amountPaid = parsedAmount;
        }
      }

      await apiClient.updateInvoicePaymentStatus(invoiceId, updateData);

      toast({
        title: "Success",
        description: `Payment status updated to ${paymentStatusData.paymentStatus}`,
      });

      // Close dialog and refresh invoices
      setShowPaymentStatusDialog(false);
      fetchInvoices();
      fetchStats();
    } catch (error) {
      console.error('Error updating payment status:', error);
      const errorMessage = (error as any).message || 'Failed to update payment status';

      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setPaymentStatusLoading(false);
    }
  };

  const handleDownloadPDF = async (invoice: Invoice) => {
    try {
      await apiClient.downloadInvoicePDF(invoice._id || invoice.id);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to download invoice PDF",
        variant: "destructive",
      });
    }
  };

  const handleEditClick = (invoice: Invoice) => {
    setInvoiceToEdit(invoice);
    setShowEditDialog(true);
  };

  const handleDeleteClick = (id: string) => {
    if (!id) {
      toast({
        title: "Error",
        description: "Invoice ID not found",
        variant: "destructive",
      });
      return;
    }
    setInvoiceToDelete(id);
    setShowDeleteDialog(true);
  };

  const confirmDeleteInvoice = async () => {
    if (!invoiceToDelete) return;

    try {
      await apiClient.deleteInvoice(invoiceToDelete);
      toast({
        title: "Success",
        description: "Invoice deleted successfully",
      });
      fetchInvoices();
      fetchStats();
    } catch (error) {
      console.error('Error deleting invoice:', error);
      toast({
        title: "Error",
        description: "Failed to delete invoice",
        variant: "destructive",
      });
    } finally {
      setShowDeleteDialog(false);
      setInvoiceToDelete(null);
    }
  };

  const handleInvoiceUpdated = async () => {
    fetchInvoices();
    fetchStats();

    // Refresh the selected invoice to show updated data in the dialog
    if (selectedInvoice) {
      try {
        const response = await apiClient.getInvoice(selectedInvoice.id);
        setSelectedInvoice(response.data.invoice);
      } catch (error) {
        console.error('Error refreshing invoice:', error);
      }
    }
  };

  const getStatusConfig = (status: string) => {
    const configs = {
      "draft": { variant: "secondary" as const, label: "Draft" },
      "sent": { variant: "default" as const, label: "Sent" },
      "paid": { variant: "success" as const, label: "Paid" },
      "overdue": { variant: "destructive" as const, label: "Overdue" },
      "cancelled": { variant: "outline" as const, label: "Cancelled" },
      "refunded": { variant: "secondary" as const, label: "Refunded" },
    };
    return configs[status as keyof typeof configs] || configs["draft"];
  };

  const getPaymentStatusConfig = (status: string, dueDate?: string) => {
    // Check if invoice is overdue
    const isOverdue = status === 'pending' && dueDate && new Date(dueDate) < new Date();
    const effectiveStatus = isOverdue ? 'overdue' : status;
    
    const configs = {
      "pending": { variant: "secondary" as const, label: "Pending" },
      "partial": { variant: "default" as const, label: "Partial" },
      "paid": { variant: "success" as const, label: "Paid" },
      "overdue": { variant: "destructive" as const, label: "Overdue" },
    };
    return configs[effectiveStatus as keyof typeof configs] || configs["pending"];
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Invoice Management</h1>
          <p className="text-muted-foreground text-sm">
            Create, manage, and track invoices
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          Create Invoice
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <FileText className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Invoices</p>
              <p className="text-xl font-bold">{stats.totalInvoices}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <DollarSign className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Amount</p>
              <p className="text-xl font-bold">₹{stats.totalAmount.toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-600" />
            <div>
              <p className="text-xs text-muted-foreground">Paid Amount</p>
              <p className="text-xl font-bold text-green-600">₹{stats.paidAmount.toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Clock className="w-5 h-5 text-orange-600" />
            <div>
              <p className="text-xs text-muted-foreground">Pending Amount</p>
              <p className="text-xl font-bold text-orange-600">₹{stats.pendingAmount.toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <div className="flex items-center space-x-4 flex-wrap gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by invoice number, customer, or job..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="refunded">Refunded</SelectItem>
          </SelectContent>
        </Select>

        <Select value={paymentStatusFilter} onValueChange={setPaymentStatusFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Payment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Payments</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="partial">Partial</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Invoices Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">All Invoices</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
              Loading invoices...
            </div>
          ) : filteredInvoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <FileText className="h-10 w-10 text-muted-foreground opacity-40" />
              <h3 className="text-lg font-semibold">
                {invoices.length === 0 ? "No invoices yet" : "No invoices found"}
              </h3>
              <p className="text-muted-foreground text-sm max-w-sm">
                {invoices.length === 0
                  ? "Create your first invoice to get started with billing"
                  : "Try adjusting your search or filter criteria"
                }
              </p>
              {invoices.length === 0 ? (
                <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Create Your First Invoice
                </Button>
              ) : (
                <Button variant="outline" onClick={() => {
                  setSearchTerm("");
                  setStatusFilter("all");
                  setPaymentStatusFilter("all");
                }}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">Invoice #</th>
                    <th className="text-left px-4 py-3 font-medium">Customer</th>
                    <th className="text-left px-4 py-3 font-medium">Due Date</th>
                    <th className="text-left px-4 py-3 font-medium">Amount</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Payment</th>
                    <th className="text-left px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvoices.map((invoice) => {
                    const statusConfig = getStatusConfig(invoice.status);
                    const paymentStatusConfig = getPaymentStatusConfig(invoice.paymentStatus, invoice.dueDate);
                    const invoiceId = invoice._id || invoice.id;

                    return (
                      <tr
                        key={invoiceId}
                        className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                        onClick={() => handleViewInvoice(invoice)}
                      >
                        <td className="px-4 py-3 font-mono">
                          <div className="flex items-center gap-2">
                            {invoice.invoiceNumber}
                            {invoice.noGst && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-sans">
                                No GST
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div>{invoice.customerId.name}</div>
                          {invoice.jobId && (
                            <div className="text-xs text-muted-foreground">{invoice.jobId.title}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(invoice.dueDate).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">₹{invoice.totalAmount.toLocaleString()}</div>
                          {invoice.balanceDue > 0 && (
                            <div className="text-xs text-orange-600">Bal: ₹{invoice.balanceDue.toLocaleString()}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={paymentStatusConfig.variant}
                            className="cursor-pointer hover:opacity-80 transition-opacity"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePaymentStatusClick(invoice);
                            }}
                          >
                            {paymentStatusConfig.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(invoice.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuItem onClick={() => handleViewInvoice(invoice)}>
                                <Eye className="h-4 w-4 mr-2" />
                                View
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleEditClick(invoice)}>
                                <Pencil className="h-4 w-4 mr-2" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handlePaymentStatusClick(invoice)}>
                                <DollarSign className="h-4 w-4 mr-2" />
                                Update Payment
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleDownloadPDF(invoice)}>
                                <Download className="h-4 w-4 mr-2" />
                                Download PDF
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleDeleteClick(invoiceId)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      <AdvancedCreateInvoiceDialog 
        open={showCreateDialog} 
        onOpenChange={setShowCreateDialog}
        onInvoiceCreated={() => {
          fetchInvoices();
          fetchStats();
        }}
      />
      
      <ViewInvoiceDialog
        open={showViewDialog}
        onOpenChange={setShowViewDialog}
        invoice={selectedInvoice}
        onInvoiceUpdated={handleInvoiceUpdated}
      />

      <EditInvoiceDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        invoice={invoiceToEdit as any}
        onInvoiceUpdated={() => {
          fetchInvoices();
          fetchStats();
        }}
      />

      {/* Payment Status Update Dialog */}
      <Dialog open={showPaymentStatusDialog} onOpenChange={setShowPaymentStatusDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              Update Payment Status
            </DialogTitle>
            <DialogDescription>
              {selectedInvoice && `Update status for invoice ${selectedInvoice.invoiceNumber}`}
            </DialogDescription>
          </DialogHeader>

          {/* Invoice Payment Summary */}
          {selectedInvoice && (
            <div className="bg-muted rounded-lg p-4 space-y-2 mb-4">
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Invoice Total:</span>
                <span className="font-semibold">₹{(selectedInvoice.totalAmount || 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Already Paid:</span>
                <span className="font-semibold text-green-600">₹{(selectedInvoice.amountPaid || 0).toLocaleString()}</span>
              </div>
              <div className="border-t border-muted-foreground/20 pt-2 flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Balance Due:</span>
                <span className="font-semibold text-orange-600">₹{(selectedInvoice.balanceDue || 0).toLocaleString()}</span>
              </div>
            </div>
          )}

          <div className="space-y-6">
            {/* Payment Status Selection */}
            <div className="space-y-2">
              <Label htmlFor="paymentStatus">Payment Status</Label>
              <Select
                value={paymentStatusData.paymentStatus}
                onValueChange={(value) =>
                  setPaymentStatusData(prev => ({ ...prev, paymentStatus: value }))
                }
              >
                <SelectTrigger id="paymentStatus">
                  <SelectValue placeholder="Select payment status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      Pending
                    </div>
                  </SelectItem>
                  <SelectItem value="partial">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      Partial
                    </div>
                  </SelectItem>
                  <SelectItem value="paid">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-4 w-4" />
                      Paid
                    </div>
                  </SelectItem>
                  {selectedInvoice && new Date(selectedInvoice.dueDate) <= new Date() && (
                    <SelectItem value="overdue">
                      <div className="flex items-center gap-2">
                        <AlertCircle className="h-4 w-4" />
                        Overdue
                      </div>
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Total Amount Paid */}
            <div className="space-y-2">
              <Label htmlFor="amountPaid">Total Amount Paid (₹)</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Enter the total amount paid so far (including previous payments)
              </p>
              {(() => {
                const parsedAmount = safeParseAmount(paymentStatusData.amountPaid as string);
                const totalAmount = selectedInvoice?.totalAmount || 0;
                const isExceeding = parsedAmount !== null && parsedAmount > totalAmount;

                return (
                  <>
                    {selectedInvoice && paymentStatusData.amountPaid !== '' && isExceeding && (
                      <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="text-xs font-semibold text-red-700">Amount Exceeds Invoice Total</p>
                          <p className="text-xs text-red-600">
                            Maximum allowed: ₹{totalAmount.toLocaleString()}
                          </p>
                        </div>
                      </div>
                    )}
                    <Input
                      id="amountPaid"
                      type="number"
                      value={paymentStatusData.amountPaid}
                      onChange={(e) =>
                        setPaymentStatusData(prev => ({
                          ...prev,
                          amountPaid: e.target.value
                        }))
                      }
                      placeholder="0.00"
                      min="0"
                      max={totalAmount}
                      step="0.01"
                      className={isExceeding ? 'border-red-500 focus-visible:ring-red-500' : ''}
                    />
                    {selectedInvoice && paymentStatusData.amountPaid !== '' && parsedAmount !== null && (
                      <div className="mt-3 space-y-1">
                        <p className="text-xs text-muted-foreground">
                          Invoice Total: ₹{totalAmount.toLocaleString()}
                        </p>
                        {isExceeding ? (
                          <p className="text-sm font-semibold text-red-600">
                            ⚠️ Exceeds by: ₹{(parsedAmount - totalAmount).toLocaleString()}
                          </p>
                        ) : (
                          <p className="text-sm font-semibold text-green-600">
                            ✓ Remaining: ₹{Math.max(0, totalAmount - parsedAmount).toLocaleString()}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowPaymentStatusDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpdatePaymentStatus}
              disabled={paymentStatusLoading || !paymentStatusData.paymentStatus}
              className="gap-2"
            >
              {paymentStatusLoading ? "Updating..." : (
                <>
                  <CheckCircle className="h-4 w-4" />
                  Update Status
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete Invoice
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this invoice? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => {
                setShowDeleteDialog(false);
                setInvoiceToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteInvoice}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" />
              Delete Invoice
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}