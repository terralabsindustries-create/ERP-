import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { Receipt } from "lucide-react";
import { lineDraftFrom, lineInput } from "@/components/billing/lineDraft";
import { describeArea, documentTotals, priceLine } from "@/lib/billing";
import { formatINR } from "@/lib/format";

interface JobInvoiceDialogProps {
  children: React.ReactNode;
  job: any;
  onInvoiceGenerated?: () => void;
}

export function JobInvoiceDialog({ children, job, onInvoiceGenerated }: JobInvoiceDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    customer_id: job.customerId || "",
    payment_terms: "Immediate",
    notes: "",
    po_reference: "",
    terms_conditions: ""
  });

  // The job's lines as the invoice will price them (lib/billing.ts, the same
  // as the server): area lines are length × width × pieces × rate. The design
  // charge comes across before tax; invoices carry no GST.
  const lines = (job.items || []).map((item: any, i: number) => lineInput(lineDraftFrom(i, item)));
  const designCharge = job.designCharge?.amount || 0;
  const totals = documentTotals(lines.map((l: ReturnType<typeof lineInput>) => priceLine(l).amount), designCharge);

  // Fetch customers when dialog opens
  const fetchCustomers = async () => {
    try {
      const customersData = await apiClient.listAll('/customers', 'customers');
      console.log('👥 Processed customers:', customersData);
      setCustomers(customersData);
      
      // Set default customer if job has one
      if (job.customerId) {
        setFormData(prev => ({ ...prev, customer_id: job.customerId }));
      }
    } catch (error) {
      console.error('Error fetching customers:', error);
      setCustomers([]); // Set empty array on error
      toast({
        title: "Error",
        description: "Failed to fetch customers",
        variant: "destructive",
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.customer_id) {
      toast({
        title: "Error",
        description: "Please select a customer",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);

    try {
      // The server prices every line again; only quantities, sizes and rates are sent.
      const items = (job.items || []).map((item: any, i: number) => ({
        itemName: item.itemName,
        description: item.description || '',
        ...lines[i]
      }));

      const invoiceData = {
        jobId: job._id,
        customerId: formData.customer_id,
        items: items,
        designCharge,
        paymentTerms: formData.payment_terms,
        notes: [formData.notes, formData.po_reference ? `PO: ${formData.po_reference}` : ''].filter(Boolean).join('\n'),
        termsAndConditions: formData.terms_conditions
      };

      console.log('📄 Creating invoice with data:', invoiceData);

      const response = await apiClient.createInvoice(invoiceData);
      console.log('📄 Invoice created:', response);

      // Get the invoice ID from the response
      const created = response as { invoice?: { _id?: string; id?: string }; _id?: string; id?: string };
      const invoiceId = created?.invoice?._id || created?._id || created?.id;

      if (!invoiceId) {
        throw new Error('Invoice ID not received from server');
      }

      console.log('📄 Invoice ID:', invoiceId);

      toast({
        title: "Success",
        description: "Invoice generated successfully. Starting PDF download...",
      });

      // Wait a moment for the invoice to be fully saved, then download PDF
      setTimeout(async () => {
        try {
          console.log('📥 Starting automatic PDF download for invoice:', invoiceId);
          await apiClient.downloadInvoicePDF(invoiceId);

          toast({
            title: "Download Complete",
            description: "Invoice PDF has been downloaded",
          });
        } catch (downloadError) {
          console.error('Error downloading PDF:', downloadError);
          toast({
            title: "PDF Download Failed",
            description: "Invoice was created but PDF download failed. You can download it manually from the invoices page.",
            variant: "destructive",
          });
        } finally {
          setOpen(false);
          onInvoiceGenerated?.();
        }
      }, 500);
    } catch (error: any) {
      console.error('Error generating invoice:', error);
      if (error.stockCheck?.length > 0) {
        const lines = (error.details as string[]) || error.stockCheck.map((s: any) =>
          `"${s.itemName}": Available ${s.availableQuantity}, Required ${s.requiredQuantity} (${s.unit})`
        );
        toast({
          title: "Insufficient Stock",
          description: lines.join('\n'),
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error",
          description: error.message || "Failed to generate invoice",
          variant: "destructive",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild onClick={fetchCustomers}>
        {children}
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="w-5 h-5" />
            Generate Invoice - {job.title}
          </DialogTitle>
          <DialogDescription>
            Create a professional invoice for this job
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Customer Selection */}
          <div className="space-y-2">
            <Label htmlFor="customer">Customer</Label>
            <Select value={formData.customer_id} onValueChange={(value) => 
              setFormData(prev => ({ ...prev, customer_id: value }))
            }>
              <SelectTrigger>
                <SelectValue placeholder="Select customer" />
              </SelectTrigger>
              <SelectContent>
                {Array.isArray(customers) && customers.map((customer) => (
                  <SelectItem key={customer.id} value={customer.id}>
                    {customer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Additional Fields */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="payment_terms">Payment Terms</Label>
              <Select value={formData.payment_terms} onValueChange={(value) => 
                setFormData(prev => ({ ...prev, payment_terms: value }))
              }>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Immediate">Immediate</SelectItem>
                  <SelectItem value="15 Days">15 Days</SelectItem>
                  <SelectItem value="30 Days">30 Days</SelectItem>
                  <SelectItem value="45 Days">45 Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="po_reference">PO Reference</Label>
              <Input
                id="po_reference"
                value={formData.po_reference}
                onChange={(e) => setFormData(prev => ({ ...prev, po_reference: e.target.value }))}
                placeholder="Purchase Order Reference"
              />
            </div>
          </div>

          {/* Notes and Terms */}
          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Additional notes for the invoice"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="terms_conditions">Terms & Conditions</Label>
            <Textarea
              id="terms_conditions"
              value={formData.terms_conditions}
              onChange={(e) => setFormData(prev => ({ ...prev, terms_conditions: e.target.value }))}
              placeholder="Terms and conditions"
              rows={3}
            />
          </div>

          {/* Invoice Items Summary */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Invoice Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Items Section */}
              {job.items && job.items.length > 0 ? (
                <div className="space-y-3">
                  <div className="font-semibold text-sm mb-2">Invoice Items:</div>
                  <div className="space-y-2">
                    {job.items.map((item: any, index: number) => {
                      const line = lines[index];
                      const area = describeArea(line);
                      return (
                        <div key={index} className="flex justify-between text-sm p-2 border rounded">
                          <div className="flex-1">
                            <div className="font-medium">{item.itemName}</div>
                            <div className="text-xs text-muted-foreground">
                              {area ? `${area} × ${formatINR(line.unitPrice)}` : `Qty: ${line.quantity} × ${formatINR(line.unitPrice)}`}
                            </div>
                          </div>
                          <div className="text-right font-medium">{formatINR(priceLine(line).amount)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">No items added to this job</div>
              )}

              {/* Totals */}
              <div className="mt-4 pt-4 border-t space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Items subtotal:</span>
                  <span>{formatINR(totals.subtotal)}</span>
                </div>
                {designCharge > 0 && (
                  <div className="flex justify-between text-sm">
                    <span>Design charge:</span>
                    <span>{formatINR(designCharge)}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold text-base pt-2 border-t">
                  <span>Total:</span>
                  <span className="text-success-strong">{formatINR(totals.total)}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Submit Button */}
          <div className="flex justify-end space-x-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Generating..." : "Generate Invoice"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}