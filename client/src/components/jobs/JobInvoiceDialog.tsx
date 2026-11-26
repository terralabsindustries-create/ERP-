import { useRef, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { draftTotals, lineDraftFromJobItem, lineInput } from "@/components/billing/lineDraft";
import { describeArea, gstByRate, priceLine } from "@/lib/billing";
import { formatINR } from "@/lib/format";
import { CustomerSearch, customerIdOf, type CustomerOption } from "@/components/customers/CustomerSearch";

interface JobInvoiceDialogProps {
  children: React.ReactNode;
  job: any;
  /** The invoice was saved; the caller offers its Print / Download / Send actions. */
  onInvoiceGenerated?: (invoice: { _id: string; invoiceNumber?: string; totalAmount?: number; status?: string }) => void;
}

export function JobInvoiceDialog({ children, job, onInvoiceGenerated }: JobInvoiceDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // One save at a time: a second click or Enter while saving creates nothing.
  const saving = useRef(false);
  // The job's customer comes populated from the create response, or as an id.
  const jobCustomer: CustomerOption | null = job.customerId && typeof job.customerId === "object" ? job.customerId : null;
  const jobCustomerId = typeof job.customerId === "string" ? job.customerId : customerIdOf(jobCustomer);
  const [customer, setCustomer] = useState<CustomerOption | null>(jobCustomer);
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    customer_id: jobCustomerId,
    payment_terms: "Immediate",
    notes: "",
    po_reference: "",
    terms_conditions: "",
    isInterState: false
  });

  // The job's lines as the invoice will price them (lib/billing.ts, the same
  // as the server): prices before tax, each at the job ticket's GST rate, and
  // the design charge at its own — so the invoice total is the job ticket's.
  const drafts = (job.items || []).map((item: any, i: number) => lineDraftFromJobItem(i, item));
  const lines = drafts.map(lineInput);
  const designCharge = job.designCharge?.amount || 0;
  const designChargeGstRate = designCharge > 0 ? job.designCharge?.gstRate || 0 : 0;
  const totals = draftTotals(drafts, { amount: designCharge, gstRate: designChargeGstRate }, 0, formData.isInterState);
  const rates = gstByRate([...totals.lines, totals.design]);


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
    if (saving.current) return;

    saving.current = true;
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
        designChargeGstRate,
        isInterState: formData.isInterState,
        status: 'sent',
        paymentTerms: formData.payment_terms,
        notes: [formData.notes, formData.po_reference ? `PO: ${formData.po_reference}` : ''].filter(Boolean).join('\n'),
        termsAndConditions: formData.terms_conditions
      };

      const response = await apiClient.createInvoice(invoiceData);

      const created = response as { invoice?: { _id?: string; id?: string; invoiceNumber?: string; totalAmount?: number; status?: string }; _id?: string; id?: string };
      const invoice = created?.invoice || (created as { _id?: string; id?: string; invoiceNumber?: string });
      const invoiceId = invoice?._id || invoice?.id;

      if (!invoiceId) {
        throw new Error('Invoice ID not received from server');
      }

      // Saved. No PDF is downloaded here: the caller offers Print / Download / Send.
      setOpen(false);
      onInvoiceGenerated?.({ ...invoice, _id: invoiceId });
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
      saving.current = false;
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
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
            <CustomerSearch
              id="customer"
              value={formData.customer_id}
              customer={customer}
              onSelect={(c) => {
                setCustomer(c);
                setFormData(prev => ({ ...prev, customer_id: customerIdOf(c) }));
              }}
            />
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
                              {` · GST ${line.gstRate}%`}
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
                    <span>Design charge (GST {designChargeGstRate}%):</span>
                    <span>{formatINR(designCharge)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span>Taxable amount:</span>
                  <span>{formatINR(totals.taxableAmount)}</span>
                </div>
                {rates.map((r) =>
                  formData.isInterState ? (
                    <div key={r.rate} className="flex justify-between text-sm">
                      <span>IGST @ {r.rate}%:</span>
                      <span>{formatINR(r.igst)}</span>
                    </div>
                  ) : (
                    <div key={r.rate} className="flex justify-between text-sm">
                      <span>CGST + SGST @ {r.rate / 2}% + {r.rate / 2}%:</span>
                      <span>{formatINR(r.gst)}</span>
                    </div>
                  )
                )}
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="job-invoice-interstate"
                    checked={formData.isInterState}
                    onCheckedChange={(v) => setFormData((prev) => ({ ...prev, isInterState: v === true }))}
                  />
                  <Label htmlFor="job-invoice-interstate" className="font-normal text-muted-foreground">
                    Supply to another state (IGST)
                  </Label>
                </div>
                <div className="flex justify-between font-semibold text-base pt-2 border-t">
                  <span>Total (incl. GST):</span>
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
