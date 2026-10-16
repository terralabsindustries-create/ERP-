import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { Plus, Trash2, Calculator, UserPlus } from "lucide-react";
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";
import { QuickCreateJobDialog } from "@/components/jobs/QuickCreateJobDialog";
import { BillingTotals } from "@/components/billing/BillingTotals";
import { LinePricingFields } from "@/components/billing/LinePricingFields";
import { lineAmount, lineDraftFrom, lineInput, lineProblem, newLineDraft, type LineDraft } from "@/components/billing/lineDraft";
import { documentTotals, isAreaUnit } from "@/lib/billing";
import { localDate } from "@/lib/format";

interface AdvancedCreateInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the created invoice, so a caller can act on it (e.g. download the PDF). */
  onInvoiceCreated: (invoice?: any) => void;
  preselectedJob?: any;
  preselectedCustomer?: any;
}

export function AdvancedCreateInvoiceDialog({
  open,
  onOpenChange,
  onInvoiceCreated,
  preselectedJob,
  preselectedCustomer
}: AdvancedCreateInvoiceDialogProps) {
  const [customers, setCustomers] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState<{ [key: number]: boolean }>({});
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  const [showCreateJob, setShowCreateJob] = useState(false);
  const { toast } = useToast();

  // Hide suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.autocomplete-container')) {
        setShowSuggestions({});
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Helper function to get date 30 days from now
  const getDefaultDueDate = () => {
    const date = new Date();
    date.setDate(date.getDate() + 30);
    return localDate(date);
  };

  const emptyForm = () => ({
    customerId: "",
    jobId: "",
    invoiceDate: localDate(),
    dueDate: getDefaultDueDate(),
    items: [] as LineDraft[],
    // Typed text, so the fields can be cleared.
    designCharge: "",
    discountAmount: "",
    notes: "",
    termsAndConditions: ""
  });
  const [formData, setFormData] = useState(emptyForm);
  const nextKey = useRef(1);
  const key = () => nextKey.current++;

  useEffect(() => {
    if (open) {
      fetchCustomers();
      fetchJobs();
      fetchInventoryItems();
    }
  }, [open]);

  // Pre-fill once per opening. The callers rebuild preselectedCustomer on every
  // render, so an effect that re-ran on it would throw away edits made to the
  // rows in the meantime.
  const prefilledFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      prefilledFor.current = null;
      return;
    }

    const target = preselectedJob
      ? `job:${preselectedJob.id || preselectedJob._id}`
      : preselectedCustomer
        ? `customer:${preselectedCustomer._id || preselectedCustomer.id}`
        : null;

    if (!target || prefilledFor.current === target) return;
    prefilledFor.current = target;

    if (preselectedJob) {
      // Safe date formatting for dueDate
      const formatDateForInput = (dateValue: any) => {
        if (!dateValue) return "";
        const date = new Date(dateValue);
        if (isNaN(date.getTime())) return "";
        return localDate(date);
      };

      // The job already carries its priced items — bring them in so the
      // totals are filled in. Rows stay editable, and a job with no items
      // still opens empty for manual entry. Its design charge comes across as
      // the amount before tax; invoices carry no GST.
      const items = (preselectedJob.items || []).map((item: any) => lineDraftFrom(key(), item));

      const newFormData = {
        customerId: preselectedJob.customerId?._id || preselectedJob.customerId || "",
        jobId: preselectedJob.id || preselectedJob._id || "",
        // A job without a due date must not blank out the field — the invoice
        // falls back to the same 30-day default it starts with.
        dueDate: formatDateForInput(preselectedJob.dueDate) || getDefaultDueDate(),
        items,
        designCharge: preselectedJob.designCharge?.amount ? String(preselectedJob.designCharge.amount) : ""
      };

      console.log('🔍 AdvancedCreateInvoiceDialog - pre-filled from job:', newFormData.jobId, 'items:', items.length);

      setFormData(prev => ({
        ...prev,
        ...newFormData
      }));
    } else if (preselectedCustomer) {
      setFormData(prev => ({
        ...prev,
        customerId: preselectedCustomer._id || preselectedCustomer.id || ""
      }));
    }
  }, [open, preselectedJob, preselectedCustomer]);

  const fetchCustomers = async () => {
    try {
      const customersData = await apiClient.listAll('/customers', 'customers');
      setCustomers(customersData);
    } catch (error) {
      console.error('Error fetching customers:', error);
    }
  };

  // The dialog just created a customer inline — add it to the list without a
  // refetch and select it, so the person invoicing never loses their place.
  const handleCustomerCreated = (customer?: any) => {
    if (customer) {
      setCustomers((prev) => [...prev, customer]);
      setFormData((prev) => ({ ...prev, customerId: customer._id || customer.id }));
    }
    setShowCreateCustomer(false);
  };

  // Mirrors handleCustomerCreated: add the new job locally and select it,
  // guarding against Radix resetting the value (see the onValueChange comment
  // on the Job Select below).
  const handleJobCreated = (job?: any) => {
    if (job) {
      setJobs((prev) => [...prev, job]);
      setFormData((prev) => ({ ...prev, jobId: job._id || job.id }));
    }
    setShowCreateJob(false);
  };

  const fetchJobs = async () => {
    try {
      const jobsData = await apiClient.listAll('/jobs', 'jobs');
      setJobs(jobsData);
    } catch (error) {
      console.error('Error fetching jobs:', error);
    }
  };

  const fetchInventoryItems = async () => {
    try {
      const response = await apiClient.getInventory();
      const inventoryData = Array.isArray(response) ? response : ((response as { inventory?: unknown[] })?.inventory || []);
      setInventoryItems(inventoryData);
      console.log('🔍 Inventory items loaded:', inventoryData.length);
    } catch (error) {
      console.error('Error fetching inventory items:', error);
    }
  };

  const addItem = () => {
    setFormData(prev => ({ ...prev, items: [...prev.items, newLineDraft(key())] }));
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

  // The same arithmetic as the server (lib/billing.ts ↔ backend utils/billing.js):
  // lines, plus the design charge, less the discount. No GST.
  const calculateTotals = () =>
    documentTotals(formData.items.map(lineAmount), Number(formData.designCharge) || 0, Number(formData.discountAmount) || 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const problem = !formData.customerId
      ? "Select a customer."
      : formData.items.length === 0
        ? "Add at least one item."
        : formData.items.map((l, i) => lineProblem(l, i + 1)).find(Boolean) ||
          (Number(formData.designCharge) < 0 ? "The design charge can't be negative." : "") ||
          (calculateTotals().discount > calculateTotals().gross ? "The discount is more than the invoice." : "");
    if (problem) {
      toast({ title: "Check the invoice", description: problem, variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const invoiceData = {
        customerId: formData.customerId,
        jobId: formData.jobId,
        invoiceDate: formData.invoiceDate,
        dueDate: formData.dueDate,
        items: formData.items.map((l) => ({ itemName: l.itemName.trim(), description: l.description.trim(), ...lineInput(l) })),
        designCharge: Number(formData.designCharge) || 0,
        discountAmount: Number(formData.discountAmount) || 0,
        notes: formData.notes,
        termsAndConditions: formData.termsAndConditions
      };

      const response: any = await apiClient.createInvoice(invoiceData);

      toast({
        title: "Invoice created",
        description: response?.invoice?.invoiceNumber || undefined,
      });

      onInvoiceCreated(response?.invoice || response);
      onOpenChange(false);
      setFormData(emptyForm());
    } catch (error: any) {
      console.error('Error creating invoice:', error);
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
          title: "Failed to create invoice",
          description: error?.message || "An unexpected error occurred",
          variant: "destructive",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const totals = calculateTotals();

  // The best discount for this customer and order (Discounts page), offered
  // as a one-click suggestion; the person invoicing decides.
  const [discountHint, setDiscountHint] = useState<{ name: string; label: string; amount: number } | null>(null);
  const subtotalForHint = totals.gross;
  useEffect(() => {
    if (!open || !formData.customerId || subtotalForHint <= 0) {
      setDiscountHint(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = (await apiClient.calculateDiscount(formData.customerId, subtotalForHint)) as { discountAmount?: number; appliedRule?: { name: string; label: string } | null };
        if (!cancelled) setDiscountHint(res?.appliedRule && (res.discountAmount || 0) > 0 ? { name: res.appliedRule.name, label: res.appliedRule.label, amount: res.discountAmount || 0 } : null);
      } catch {
        if (!cancelled) setDiscountHint(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, formData.customerId, subtotalForHint]);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{preselectedJob ? 'Generate Invoice' : 'Create Invoice'}</DialogTitle>
          <DialogDescription>
            {preselectedJob
              ? 'Generate an invoice for this job — its items are filled in below and stay editable.'
              : 'Price each line per unit or by size (length × width), and add a design charge if there is one.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Customer and Job Selection */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="customerId">Customer *</Label>
                {!preselectedJob && (
                  <Button type="button" variant="ghost" size="sm" className="gap-1 h-auto py-1" onClick={() => setShowCreateCustomer(true)}>
                    <UserPlus className="w-3.5 h-3.5" />
                    New Customer
                  </Button>
                )}
              </div>
              {preselectedJob ? (
                // Fixed customer display when job is preselected
                <div className="p-3 bg-muted/50 border rounded-md">
                  <div className="font-medium text-foreground">
                    {customers.find(c => (c._id || c.id) === formData.customerId)?.name
                      || preselectedCustomer?.name || 'Loading...'}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {customers.find(c => (c._id || c.id) === formData.customerId)?.email
                      || preselectedCustomer?.email || ''}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    (Fixed - Cannot be changed)
                  </div>
                </div>
              ) : (
                // Editable customer selection when no job is preselected
                <Select
                  value={formData.customerId}
                  onValueChange={(value) => {
                    // Radix calls this with "" to self-correct a controlled value
                    // it doesn't recognize — which is exactly the state right
                    // after we set customerId to a customer just created inline,
                    // since its SelectItem has never been mounted (that only
                    // happens once the dropdown has been opened). This is a
                    // fully controlled Select, so as long as we don't act on
                    // that spurious "", the value we set simply stays put.
                    if (value) setFormData(prev => ({ ...prev, customerId: value }));
                  }}
                >
                  <SelectTrigger>
                    {/* Radix only resolves a label from a SelectItem that has been
                        mounted at least once (i.e. the dropdown was opened while
                        it was selected). Selecting a customer programmatically —
                        right after creating one inline — skips that, so the
                        display text is set explicitly here instead. */}
                    <SelectValue placeholder="Select customer">
                      {(() => {
                        const c = customers.find((cust) => (cust._id || cust.id) === formData.customerId);
                        return c ? `${c.name} - ${c.email}` : "";
                      })()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((customer) => (
                      <SelectItem key={customer._id || customer.id} value={customer._id || customer.id}>
                        {customer.name} - {customer.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="jobId">Job</Label>
                {!preselectedJob && (
                  <Button type="button" variant="ghost" size="sm" className="gap-1 h-auto py-1" onClick={() => setShowCreateJob(true)}>
                    <Plus className="w-3.5 h-3.5" />
                    New Job
                  </Button>
                )}
              </div>
              {preselectedJob ? (
                // Fixed job display when job is preselected
                <div className="p-3 bg-muted/50 border rounded-md">
                  <div className="font-medium text-foreground">
                    {jobs.find(j => (j._id || j.id) === formData.jobId)?.title
                      || preselectedJob?.title || 'Loading...'}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Customer: {(() => {
                      const j = jobs.find(job => (job._id || job.id) === formData.jobId);
                      return j?.customerId?.name || j?.customer || preselectedCustomer?.name || 'Unknown Customer';
                    })()}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    (Fixed - Cannot be changed)
                  </div>
                </div>
              ) : (
                // Editable job selection when no job is preselected
                <Select
                  value={formData.jobId}
                  onValueChange={(value) => {
                    // See the identical guard on the Customer Select above —
                    // Radix self-corrects an unrecognized controlled value by
                    // calling this with "", which happens for a job just
                    // created inline since its SelectItem was never mounted.
                    if (value) setFormData(prev => ({ ...prev, jobId: value }));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select job (optional)">
                      {(() => {
                        const j = jobs.find((job) => (job._id || job.id) === formData.jobId);
                        return j ? `${j.title} - ${j.customerId?.name || j.customer || 'Unknown Customer'}` : "";
                      })()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {jobs.map((job) => (
                      <SelectItem key={job._id || job.id} value={job._id || job.id}>
                        {job.title} - {job.customerId?.name || job.customer || 'Unknown Customer'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {/* Invoice Dates */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="invoiceDate">Invoice Date *</Label>
              <Input
                id="invoiceDate"
                type="date"
                value={formData.invoiceDate}
                onChange={(e) => setFormData(prev => ({ ...prev, invoiceDate: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dueDate">Due Date</Label>
              <Input
                id="dueDate"
                type="date"
                value={formData.dueDate}
                onChange={(e) => setFormData(prev => ({ ...prev, dueDate: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Default: 30 days from invoice date
              </p>
            </div>
          </div>

          {/* Line Items */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Invoice Items</span>
                <Button type="button" onClick={addItem} size="sm">
                  <Plus className="h-4 w-4" />
                  Add Item
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {formData.items.map((item, index) => (
                <div key={item.key} className="space-y-3 p-4 border rounded-lg">
                  <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2 md:items-end">
                    <div className="space-y-1 relative autocomplete-container">
                      <Label htmlFor={`inv-item-${item.key}`} className="text-xs">Item name *</Label>
                      <Input
                        id={`inv-item-${item.key}`}
                        value={item.itemName}
                        onChange={(e) => {
                          updateItem(index, { itemName: e.target.value });
                          setShowSuggestions(prev => ({ ...prev, [index]: true }));
                        }}
                        onFocus={() => setShowSuggestions(prev => ({ ...prev, [index]: true }))}
                        placeholder="Type or pick an inventory item"
                        autoComplete="off"
                      />
                      {showSuggestions[index] && (() => {
                        const query = item.itemName.trim().toLowerCase();
                        const matches = query
                          ? inventoryItems.filter((inv) => inv.name.toLowerCase().includes(query)).slice(0, 8)
                          : inventoryItems.slice(0, 8);
                        return (
                          <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md">
                            {matches.length === 0 ? (
                              <div className="p-2 text-sm text-muted-foreground">
                                No matching inventory item — will be added as a custom item
                              </div>
                            ) : (
                              matches.map((selectedItem) => (
                                <button
                                  type="button"
                                  key={selectedItem._id || selectedItem.id}
                                  className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                                  onClick={() => {
                                    // Stock counted in sq ft / sq m is priced by size;
                                    // anything else per unit, in the stock's unit.
                                    const invUnit = selectedItem.unit || 'pieces';
                                    updateItem(index, {
                                      itemName: selectedItem.name,
                                      unitPrice: String(selectedItem.unitCost || 0),
                                      description: selectedItem.description || item.description,
                                      unit: invUnit,
                                      pricing: isAreaUnit(invUnit) ? invUnit : 'unit'
                                    });
                                    setShowSuggestions(prev => ({ ...prev, [index]: false }));
                                  }}
                                >
                                  <span className="font-medium">{selectedItem.name}</span>
                                  <span className="text-xs text-muted-foreground">
                                    Stock: {selectedItem.quantity || 0}{selectedItem.unit ? ` ${selectedItem.unit}` : ''} | ₹{selectedItem.unitCost || 0}
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`inv-desc-${item.key}`} className="text-xs">Description</Label>
                      <Input
                        id={`inv-desc-${item.key}`}
                        value={item.description}
                        onChange={(e) => updateItem(index, { description: e.target.value })}
                        placeholder="Material, finish… (optional)"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeItem(index)}
                      aria-label={`Remove line ${index + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <LinePricingFields line={item} idPrefix={`inv-${item.key}`} onChange={(patch) => updateItem(index, patch)} />
                </div>
              ))}

              {formData.items.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  No items added yet. Click "Add Item" to get started.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Totals */}
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
                idPrefix="invoice"
                designCharge={formData.designCharge}
                onDesignChargeChange={(v) => setFormData((prev) => ({ ...prev, designCharge: v }))}
                discount={formData.discountAmount}
                onDiscountChange={(v) => setFormData((prev) => ({ ...prev, discountAmount: v }))}
                totalLabel="Invoice total"
                discountHint={
                  discountHint && Math.abs(discountHint.amount - (Number(formData.discountAmount) || 0)) > 0.009 ? (
                    <div className="flex items-center justify-between gap-2 rounded-md bg-success-soft px-3 py-2 text-xs text-success-strong">
                      <span>
                        {discountHint.name}: {discountHint.label} = ₹{discountHint.amount.toFixed(2)}
                      </span>
                      <Button type="button" size="xs" variant="outline" onClick={() => setFormData((prev) => ({ ...prev, discountAmount: String(discountHint.amount) }))}>
                        Apply
                      </Button>
                    </div>
                  ) : null
                }
              />
            </CardContent>
          </Card>

          {/* Additional Fields */}
          <div className="space-y-4">
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
              <Label htmlFor="termsAndConditions">Terms & Conditions</Label>
              <Textarea
                id="termsAndConditions"
                value={formData.termsAndConditions}
                onChange={(e) => setFormData(prev => ({ ...prev, termsAndConditions: e.target.value }))}
                placeholder="Terms and conditions"
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading
                ? (preselectedJob ? "Generating..." : "Creating...")
                : (preselectedJob ? "Generate Invoice" : "Create Invoice")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <CreateCustomerDialog
      open={showCreateCustomer}
      onOpenChange={setShowCreateCustomer}
      onCustomerCreated={handleCustomerCreated}
    />
    <QuickCreateJobDialog
      open={showCreateJob}
      onOpenChange={setShowCreateJob}
      customers={customers}
      onJobCreated={handleJobCreated}
    />
    </>
  );
}