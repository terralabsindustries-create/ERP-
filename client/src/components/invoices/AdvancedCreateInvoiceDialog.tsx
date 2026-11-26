import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_SUGGESTIONS, SuggestionPopover } from "@/components/ui/suggestion-popover";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { jobFitsCustomer } from "@/lib/invoiceJob";
import { Plus, Trash2, Calculator, UserPlus } from "lucide-react";
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";
import { CustomerSearch, customerIdOf, useCustomerRecord, type CustomerOption } from "@/components/customers/CustomerSearch";
import { QuickCreateJobDialog } from "@/components/jobs/QuickCreateJobDialog";
import { BillingTotals } from "@/components/billing/BillingTotals";
import { LinePricingFields } from "@/components/billing/LinePricingFields";
import { draftTotals, gstRateProblem, lineDraftFromJobItem, lineInput, lineProblem, newLineDraft, type LineDraft } from "@/components/billing/lineDraft";
import { useHsnGstRates } from "@/components/billing/useHsnGstRates";
import { StockAvailability } from "@/components/billing/StockAvailability";
import { sellingRate, stockItemNamed, stockNeeded, unitText, type StockItem } from "@/components/billing/stock";
import { isAreaUnit } from "@/lib/billing";
import { localDate } from "@/lib/format";
import { InvoiceSavedDialog, savedInvoiceId, type SavedInvoice } from "@/components/invoices/InvoiceSavedDialog";
import { ConfirmDialog } from "@/components/data/ConfirmDialog";

interface AdvancedCreateInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the created invoice, so a caller can act on it (e.g. download the PDF). */
  onInvoiceCreated: (invoice?: any) => void;
  preselectedJob?: any;
  preselectedCustomer?: any;
  /**
   * The job ticket is knowingly billed again (billed in parts). Without it the
   * server refuses a second invoice for a billed job, and the person is asked.
   */
  allowAdditionalInvoice?: boolean;
}

export function AdvancedCreateInvoiceDialog({
  open,
  onOpenChange,
  onInvoiceCreated,
  preselectedJob,
  preselectedCustomer,
  allowAdditionalInvoice = false
}: AdvancedCreateInvoiceDialogProps) {
  // The chosen customer's record, once picked or created here.
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [inventoryItems, setInventoryItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState<{ [key: number]: boolean }>({});
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  const [showCreateJob, setShowCreateJob] = useState(false);
  const { toast } = useToast();

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
    designChargeGstRate: "",
    discountAmount: "",
    isInterState: false,
    notes: "",
    termsAndConditions: ""
  });
  const [formData, setFormData] = useState(emptyForm);
  // The customer shown read-only when the invoice is for a preselected job.
  const fixedCustomer = useCustomerRecord(preselectedJob ? formData.customerId : "", [customer, preselectedCustomer, preselectedJob?.customerId]);
  const nextKey = useRef(1);
  const key = () => nextKey.current++;

  useEffect(() => {
    if (open) {
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
      // still opens empty for manual entry. Prices come across before tax with
      // each item's GST rate, and the design charge with its own, so the
      // invoice adds the GST once and comes to the job ticket's total.
      const items = (preselectedJob.items || []).map((item: any) => lineDraftFromJobItem(key(), item));

      const newFormData = {
        customerId: preselectedJob.customerId?._id || preselectedJob.customerId || "",
        jobId: preselectedJob.id || preselectedJob._id || "",
        // A job without a due date must not blank out the field — the invoice
        // falls back to the same 30-day default it starts with.
        dueDate: formatDateForInput(preselectedJob.dueDate) || getDefaultDueDate(),
        items,
        designCharge: preselectedJob.designCharge?.amount ? String(preselectedJob.designCharge.amount) : "",
        designChargeGstRate: preselectedJob.designCharge?.amount ? String(preselectedJob.designCharge.gstRate ?? "") : ""
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

  // The dialog just created a customer inline — add it to the list without a
  // refetch and select it, so the person invoicing never loses their place.
  const handleCustomerCreated = (created?: any) => {
    if (created) {
      setCustomer(created);
      setFormData((prev) => ({ ...prev, customerId: customerIdOf(created), jobId: jobFitsCustomer(jobs, prev.jobId, customerIdOf(created)) ? prev.jobId : "" }));
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

  // Picking a job ticket bills it: its customer, and — while the invoice has
  // no lines of its own yet — its items (with their notes and HSN codes) and
  // design charge. Everything stays editable.
  const fillFromJob = (jobId: string) => {
    const job = jobs.find((j) => (j._id || j.id) === jobId);
    if (!job) return;
    const customerId = job.customerId?._id || job.customerId || "";
    const hasOwnLines = formData.items.some((l) => l.itemName.trim());
    const jobLines = (job.items || []).map((item: any) => lineDraftFromJobItem(key(), item));
    const takeDesign = !formData.designCharge && !!job.designCharge?.amount;
    setFormData((prev) => ({
      ...prev,
      jobId,
      customerId: customerId || prev.customerId,
      items: hasOwnLines || !jobLines.length ? prev.items : jobLines,
      designCharge: takeDesign ? String(job.designCharge.amount) : prev.designCharge,
      designChargeGstRate: takeDesign ? String(job.designCharge.gstRate ?? "") : prev.designChargeGstRate
    }));
    if (!hasOwnLines && jobLines.length) {
      toast({ title: "Filled from the job ticket", description: `${jobLines.length} item${jobLines.length === 1 ? "" : "s"} from ${job.title}` });
    }
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

  // A new line starts at the rate of the line above it; most orders carry one rate.
  const addItem = () => {
    setFormData(prev => ({ ...prev, items: [...prev.items, newLineDraft(key(), { gstRate: prev.items[prev.items.length - 1]?.gstRate || "" })] }));
  };

  // A line given an HSN code from the HSN master starts at that code's rate.
  const hsnRate = useHsnGstRates(open);

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
  // lines, plus the design charge, less the discount, plus GST at each rate.
  const calculateTotals = () =>
    draftTotals(formData.items, { amount: formData.designCharge, gstRate: formData.designChargeGstRate }, formData.discountAmount, formData.isInterState);

  // The invoice takes its stock items out of stock, and the server refuses a
  // line there isn't enough of; say so before sending.
  const neededForStock = (stock: StockItem) => formData.items.reduce(
    (total, line) => total + (line.itemName === stock.name ? stockNeeded(lineInput(line), stock.unit) : 0),
    0
  );
  const shortOfStock = () => {
    for (const [i, l] of formData.items.entries()) {
      const stock = stockItemNamed(inventoryItems, l.itemName);
      if (!stock) continue;
      const needed = neededForStock(stock);
      if (needed > (Number(stock.quantity) || 0)) return `Line ${i + 1}: ${needed} ${unitText(stock.unit)} of ${stock.name} is needed across all lines; only ${stock.quantity || 0} is in stock.`;
    }
    return "";
  };

  // One save at a time: a second click or Enter while saving creates nothing.
  const saving = useRef(false);
  // The invoice just saved, for its Print / Download / Send actions.
  const [saved, setSaved] = useState<{ invoice: SavedInvoice; title: string } | null>(null);

  // The job ticket turned out to be billed already (by someone else, or in
  // another tab): the invoice it is billed on, and the save that was refused.
  const [alreadyBilled, setAlreadyBilled] = useState<{ status: "draft" | "sent"; invoiceNumber?: string; totalAmount?: number } | null>(null);

  const submitInvoice = async (status: "draft" | "sent", additional = allowAdditionalInvoice) => {
    if (saving.current) return;
    const problem = !formData.customerId
      ? "Select a customer."
      : formData.items.length === 0
        ? "Add at least one item."
        : formData.items.map((l, i) => lineProblem(l, i + 1)).find(Boolean) ||
          shortOfStock() ||
          (Number(formData.designCharge) < 0 ? "The design charge can't be negative." : "") ||
          (Number(formData.designCharge) > 0 ? gstRateProblem(formData.designChargeGstRate, "The design charge") : "") ||
          (calculateTotals().discount > calculateTotals().gross ? "The discount is more than the invoice." : "") ||
          (calculateTotals().total <= 0 ? "The invoice total must be more than 0." : "");
    if (problem) {
      toast({ title: "Check the invoice", description: problem, variant: "destructive" });
      return;
    }

    saving.current = true;
    setLoading(true);
    try {
      const invoiceData = {
        customerId: formData.customerId,
        jobId: formData.jobId,
        ...(additional && formData.jobId ? { allowAdditionalInvoice: true } : {}),
        invoiceDate: formData.invoiceDate,
        dueDate: formData.dueDate,
        items: formData.items.map((l) => ({ itemName: l.itemName.trim(), description: l.description.trim(), hsnCode: l.hsnCode.trim(), ...lineInput(l) })),
        designCharge: Number(formData.designCharge) || 0,
        designChargeGstRate: Number(formData.designChargeGstRate) || 0,
        discountAmount: Number(formData.discountAmount) || 0,
        isInterState: formData.isInterState,
        status,
        notes: formData.notes,
        termsAndConditions: formData.termsAndConditions
      };

      const response: any = await apiClient.createInvoice(invoiceData);
      const invoice: SavedInvoice = response?.invoice || response;

      onInvoiceCreated(invoice);
      onOpenChange(false);
      setFormData(emptyForm());
      // Saved: offer Print / Download / Send. Nothing is downloaded or printed by itself.
      if (savedInvoiceId(invoice)) setSaved({ invoice, title: status === "draft" ? "Draft invoice saved" : "Invoice issued" });
      else toast({ title: status === "draft" ? "Draft saved" : "Invoice issued", description: invoice?.invoiceNumber || undefined });
    } catch (error: any) {
      console.error('Error creating invoice:', error);
      if (error.code === 'JOB_ALREADY_INVOICED') {
        setAlreadyBilled({ status, invoiceNumber: error.details?.invoiceNumber, totalAmount: error.details?.totalAmount });
      } else if (error.stockCheck?.length > 0) {
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
      saving.current = false;
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

        <form onSubmit={(e) => { e.preventDefault(); void submitInvoice("sent"); }} className="space-y-6">
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
                    {fixedCustomer?.name || preselectedCustomer?.name || 'Loading...'}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {fixedCustomer?.email || preselectedCustomer?.email || ''}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    (Fixed - Cannot be changed)
                  </div>
                </div>
              ) : (
                // Editable customer selection when no job is preselected.
                // Changing the customer keeps every line and total; only a job
                // ticket of the previous customer is dropped.
                <CustomerSearch
                  id="customerId"
                  value={formData.customerId}
                  customer={customer}
                  onSelect={(c) => {
                    setCustomer(c);
                    const id = customerIdOf(c);
                    setFormData(prev => ({ ...prev, customerId: id, jobId: jobFitsCustomer(jobs, prev.jobId, id) ? prev.jobId : "" }));
                  }}
                  onCreateNew={() => setShowCreateCustomer(true)}
                />
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
                    if (value && value !== formData.jobId) fillFromJob(value);
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
                        {job.invoices?.length > 0 && ` · billed (${job.invoices[0].invoiceNumber})`}
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
                  <div className="grid grid-cols-1 md:grid-cols-[1.3fr_1.3fr_7rem_auto] gap-2 md:items-end">
                    <div className="space-y-1">
                      <Label htmlFor={`inv-item-${item.key}`} className="text-xs">Item name *</Label>
                      <SuggestionPopover
                        open={!!showSuggestions[index]}
                        onOpenChange={(next) => setShowSuggestions(prev => ({ ...prev, [index]: next }))}
                        items={(() => {
                          const query = item.itemName.trim().toLowerCase();
                          return (query ? inventoryItems.filter((inv) => inv.name.toLowerCase().includes(query)) : inventoryItems).slice(0, MAX_SUGGESTIONS);
                        })()}
                        getKey={(selectedItem) => selectedItem._id || selectedItem.id || selectedItem.name}
                        onSelect={(selectedItem) => {
                          // Stock counted in sq ft / sq m is priced by size;
                          // anything else per unit, in the stock's unit.
                          const invUnit = selectedItem.unit || 'pieces';
                          const hsnCode = selectedItem.hsnCode || item.hsnCode;
                          updateItem(index, {
                            itemName: selectedItem.name,
                            unitPrice: String(sellingRate(selectedItem)),
                            description: item.description || selectedItem.description || '',
                            hsnCode,
                            unit: invUnit,
                            pricing: isAreaUnit(invUnit) ? invUnit : 'unit',
                            gstRate: item.gstRate || hsnRate(hsnCode)
                          });
                        }}
                        listLabel="Inventory items"
                        empty={
                          <div className="p-2 text-sm text-muted-foreground">
                            No matching inventory item — will be added as a custom item
                          </div>
                        }
                        renderItem={(selectedItem) => (
                          <div className="flex flex-col items-start">
                            <span className="font-medium">{selectedItem.name}</span>
                            <span className="text-xs text-muted-foreground">
                              In stock: {selectedItem.quantity || 0} {unitText(selectedItem.unit)} · ₹{sellingRate(selectedItem)}
                              {selectedItem.hsnCode ? ` · HSN ${selectedItem.hsnCode}` : ''}
                            </span>
                          </div>
                        )}
                      >
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
                      </SuggestionPopover>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`inv-desc-${item.key}`} className="text-xs">Note</Label>
                      <Input
                        id={`inv-desc-${item.key}`}
                        value={item.description}
                        onChange={(e) => updateItem(index, { description: e.target.value })}
                        placeholder="Material, finish… (optional)"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`inv-hsn-${item.key}`} className="text-xs">HSN code</Label>
                      <Input
                        id={`inv-hsn-${item.key}`}
                        value={item.hsnCode}
                        onChange={(e) => {
                          const hsnCode = e.target.value.replace(/\D/g, '').slice(0, 8);
                          updateItem(index, { hsnCode, ...(item.gstRate ? {} : { gstRate: hsnRate(hsnCode) }) });
                        }}
                        inputMode="numeric"
                        placeholder="Optional"
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
                  {(() => {
                    const stock = stockItemNamed(inventoryItems, item.itemName);
                    return stock ? <StockAvailability item={stock} needed={neededForStock(stock)} blocking /> : null;
                  })()}
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
                designChargeGstRate={formData.designChargeGstRate}
                onDesignChargeGstRateChange={(v) => setFormData((prev) => ({ ...prev, designChargeGstRate: v }))}
                isInterState={formData.isInterState}
                onInterStateChange={(v) => setFormData((prev) => ({ ...prev, isInterState: v }))}
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
            <Button type="button" variant="outline" disabled={loading} onClick={() => void submitInvoice("draft")}>
              Save draft
            </Button>
            <Button type="submit" disabled={loading}>
              {loading
                ? "Creating..."
                : "Create and issue invoice"}
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
      onJobCreated={handleJobCreated}
    />
    <InvoiceSavedDialog invoice={saved?.invoice || null} title={saved?.title} onClose={() => setSaved(null)} onInvoiceUpdated={() => onInvoiceCreated(saved?.invoice)} />
    <ConfirmDialog
      open={!!alreadyBilled}
      onOpenChange={(o) => !o && setAlreadyBilled(null)}
      title="This job ticket is already billed"
      description={`${alreadyBilled?.invoiceNumber ? `It is billed on ${alreadyBilled.invoiceNumber}${alreadyBilled.totalAmount != null ? ` (₹${alreadyBilled.totalAmount.toLocaleString("en-IN")})` : ""}` : "It already has an invoice"}. Create another invoice for it only if the job is billed in parts.`}
      confirmLabel="Create another invoice"
      cancelLabel="Don't create"
      destructive={false}
      onConfirm={() => alreadyBilled && submitInvoice(alreadyBilled.status, true)}
    />
    </>
  );
}
