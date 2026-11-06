import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Plus, Trash2, Calculator } from "lucide-react";
import apiClient from "@/lib/apiClient";
import { jobFitsCustomer } from "@/lib/invoiceJob";
import { useToast } from "@/hooks/use-toast";
import { localDate } from "@/lib/format";
import { BillingTotals } from "@/components/billing/BillingTotals";
import { LinePricingFields } from "@/components/billing/LinePricingFields";
import { draftTotals, gstRateProblem, lineDraftFrom, lineInput, lineProblem, newLineDraft, type LineDraft } from "@/components/billing/lineDraft";

interface InvoiceItem {
  itemName: string;
  description?: string;
  hsnCode?: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  itemType?: string;
  length?: number;
  width?: number;
}

interface Invoice {
  id: string;
  _id?: string;
  invoiceNumber: string;
  customerId: {
    _id: string;
    name: string;
  };
  jobId?: {
    _id: string;
    title: string;
  };
  invoiceDate: string;
  dueDate: string;
  items: InvoiceItem[];
  designCharge?: number;
  designChargeGstRate?: number;
  discountAmount: number;
  totalGstAmount?: number;
  totalAmount: number;
  isInterState?: boolean;
  noGst?: boolean;
  notes: string;
  termsAndConditions: string;
}

interface EditInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice | null;
  onInvoiceUpdated: () => void;
}

const asText = (n?: number) => (n ? String(n) : "");

export function EditInvoiceDialog({ open, onOpenChange, invoice, onInvoiceUpdated }: EditInvoiceDialogProps) {
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    customerId: "",
    jobId: "",
    invoiceDate: "",
    dueDate: "",
    items: [] as LineDraft[],
    designCharge: "",
    designChargeGstRate: "",
    discountAmount: "",
    isInterState: false,
    notes: "",
    termsAndConditions: ""
  });
  const nextKey = useRef(1);
  const { toast } = useToast();

  const toDateInput = (val: any) => {
    if (!val) return "";
    const d = new Date(val);
    if (isNaN(d.getTime())) return "";
    return localDate(d);
  };

  useEffect(() => {
    if (invoice && open) {
      setFormData({
        customerId: invoice.customerId?._id || (invoice.customerId as any) || "",
        jobId: invoice.jobId?._id || "",
        invoiceDate: toDateInput(invoice.invoiceDate),
        dueDate: toDateInput(invoice.dueDate),
        items: invoice.items.map((item) => lineDraftFrom(nextKey.current++, item)),
        designCharge: asText(invoice.designCharge),
        designChargeGstRate: invoice.designCharge ? String(invoice.designChargeGstRate ?? 0) : "",
        discountAmount: asText(invoice.discountAmount),
        isInterState: invoice.isInterState === true,
        notes: invoice.notes || "",
        termsAndConditions: invoice.termsAndConditions || ""
      });
    }
  }, [invoice, open]);

  useEffect(() => {
    if (open) {
      fetchCustomers();
      fetchJobs();
    }
  }, [open]);

  const fetchCustomers = async () => {
    try {
      const data = await apiClient.listAll('/customers', 'customers');
      setCustomers(data);
    } catch (error) {
      console.error('Error fetching customers:', error);
    }
  };

  const fetchJobs = async () => {
    try {
      const data = await apiClient.listAll('/jobs', 'jobs');
      setJobs(data);
    } catch (error) {
      console.error('Error fetching jobs:', error);
    }
  };

  // A new line starts at the rate of the line above it.
  const addItem = () => {
    setFormData(prev => ({ ...prev, items: [...prev.items, newLineDraft(nextKey.current++, { gstRate: prev.items[prev.items.length - 1]?.gstRate || "" })] }));
  };

  const removeItem = (index: number) => {
    setFormData(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index)
    }));
  };

  const updateItem = (index: number, patch: Partial<LineDraft>) => {
    setFormData(prev => ({
      ...prev,
      items: prev.items.map((item, i) => (i === index ? { ...item, ...patch } : item))
    }));
  };

  // An older "No GST" bill stays without GST; the server keeps it that way.
  const noGst = invoice?.noGst === true;

  // The same arithmetic the server applies when this is saved; it recomputes
  // every figure itself and ignores totals sent from here.
  const totals = draftTotals(
    noGst ? formData.items.map((l) => ({ ...l, gstRate: "0" })) : formData.items,
    { amount: formData.designCharge, gstRate: noGst ? 0 : formData.designChargeGstRate },
    formData.discountAmount,
    formData.isInterState
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invoice) return;

    const problem = formData.items.length === 0
      ? "Add at least one item."
      : formData.items.map((l, i) => lineProblem(noGst ? { ...l, gstRate: "0" } : l, i + 1)).find(Boolean) ||
        (!noGst && Number(formData.designCharge) > 0 ? gstRateProblem(formData.designChargeGstRate, "The design charge") : "") ||
        (totals.discount > totals.gross ? "The discount is more than the invoice." : "");
    if (problem) {
      toast({ title: "Check the invoice", description: problem, variant: "destructive" });
      return;
    }

    setLoading(true);

    try {
      await apiClient.updateInvoice(invoice.id || (invoice._id as string), {
        customerId: formData.customerId,
        jobId: formData.jobId === 'no-job' ? null : formData.jobId,
        invoiceDate: formData.invoiceDate,
        dueDate: formData.dueDate,
        items: formData.items.map((l) => ({ itemName: l.itemName.trim(), description: l.description.trim(), hsnCode: l.hsnCode.trim(), ...lineInput(l) })),
        designCharge: Number(formData.designCharge) || 0,
        designChargeGstRate: Number(formData.designChargeGstRate) || 0,
        discountAmount: Number(formData.discountAmount) || 0,
        isInterState: formData.isInterState,
        notes: formData.notes,
        termsAndConditions: formData.termsAndConditions
      });

      toast({
        title: "Success",
        description: "Invoice updated successfully",
      });

      onInvoiceUpdated();
      onOpenChange(false);
    } catch (error: any) {
      console.error('Error updating invoice:', error);
      toast({
        title: "Error",
        description: error.message || "Failed to update invoice",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Invoice - {invoice?.invoiceNumber}</DialogTitle>
          <DialogDescription>
            Update invoice details and items
          </DialogDescription>
        </DialogHeader>

        {noGst && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning-strong">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>This is an older No GST bill. It stays without GST when it is saved, whatever rates the lines show.</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Customer and Job Selection */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="customerId">Customer</Label>
              <Select
                value={formData.customerId}
                // A job ticket of the previous customer can't stay on the invoice.
                onValueChange={(value) => setFormData(prev => ({ ...prev, customerId: value, jobId: jobFitsCustomer(jobs, prev.jobId, value) ? prev.jobId : "no-job" }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((customer) => (
                    <SelectItem key={customer._id} value={customer._id}>
                      {customer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="jobId">Job (Optional)</Label>
              <Select
                value={formData.jobId}
                onValueChange={(value) => setFormData(prev => ({ ...prev, jobId: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select job" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="no-job">No job</SelectItem>
                  {jobs.map((job) => (
                    <SelectItem key={job._id} value={job._id}>
                      {job.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="invoiceDate">Invoice Date</Label>
              <Input
                id="invoiceDate"
                type="date"
                value={formData.invoiceDate}
                onChange={(e) => setFormData(prev => ({ ...prev, invoiceDate: e.target.value }))}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dueDate">Due Date</Label>
              <Input
                id="dueDate"
                type="date"
                value={formData.dueDate}
                onChange={(e) => setFormData(prev => ({ ...prev, dueDate: e.target.value }))}
                required
              />
            </div>
          </div>

          {/* Items */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>Invoice Items</Label>
              <Button type="button" onClick={addItem} size="sm">
                <Plus className="h-4 w-4" />
                Add Item
              </Button>
            </div>

            {formData.items.map((item, index) => (
              <Card key={item.key}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">Item {index + 1}</CardTitle>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeItem(index)}
                      aria-label={`Remove item ${index + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_7rem] gap-4">
                    <div className="space-y-2">
                      <Label htmlFor={`edit-item-${item.key}`}>Item Name</Label>
                      <Input
                        id={`edit-item-${item.key}`}
                        value={item.itemName}
                        onChange={(e) => updateItem(index, { itemName: e.target.value })}
                        placeholder="Enter item name"
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={`edit-desc-${item.key}`}>Note</Label>
                      <Input
                        id={`edit-desc-${item.key}`}
                        value={item.description}
                        onChange={(e) => updateItem(index, { description: e.target.value })}
                        placeholder="Material, finish… (optional)"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={`edit-hsn-${item.key}`}>HSN code</Label>
                      <Input
                        id={`edit-hsn-${item.key}`}
                        value={item.hsnCode}
                        onChange={(e) => updateItem(index, { hsnCode: e.target.value.replace(/\D/g, '').slice(0, 8) })}
                        inputMode="numeric"
                        placeholder="Optional"
                      />
                    </div>
                  </div>
                  <LinePricingFields line={item} idPrefix={`edit-${item.key}`} onChange={(patch) => updateItem(index, patch)} />
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Enter any additional notes"
            />
          </div>

          {/* Terms and Conditions */}
          <div className="space-y-2">
            <Label htmlFor="termsAndConditions">Terms and Conditions</Label>
            <Textarea
              id="termsAndConditions"
              value={formData.termsAndConditions}
              onChange={(e) => setFormData(prev => ({ ...prev, termsAndConditions: e.target.value }))}
              placeholder="Enter terms and conditions"
            />
          </div>

          {/* Totals Summary */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Calculator className="h-5 w-5 mr-2" />
                Invoice Totals
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BillingTotals
                totals={totals}
                idPrefix="edit-invoice"
                designCharge={formData.designCharge}
                onDesignChargeChange={(v) => setFormData((prev) => ({ ...prev, designCharge: v }))}
                designChargeGstRate={formData.designChargeGstRate}
                onDesignChargeGstRateChange={(v) => setFormData((prev) => ({ ...prev, designChargeGstRate: v }))}
                isInterState={formData.isInterState}
                onInterStateChange={(v) => setFormData((prev) => ({ ...prev, isInterState: v }))}
                discount={formData.discountAmount}
                onDiscountChange={(v) => setFormData((prev) => ({ ...prev, discountAmount: v }))}
                totalLabel="Invoice total"
              />
            </CardContent>
          </Card>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Updating..." : "Update Invoice"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
