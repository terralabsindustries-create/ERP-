import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { Plus, Trash2, Calculator, UserPlus } from "lucide-react";
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";
import { QuickCreateJobDialog } from "@/components/jobs/QuickCreateJobDialog";

interface InvoiceItem {
  itemName: string;
  description: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  hsnCode: string;
  gstRate: number;
  gstAmount: number;
  itemTotal: number;
  itemType?: 'Numbers' | 'Square Feet';
  unit?: string;
  length?: number;
  width?: number;
  totalSquareFeet?: number;
}

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
  const [hsnCodes, setHsnCodes] = useState<any[]>([]);
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
    return date.toISOString().split('T')[0];
  };

  const [formData, setFormData] = useState({
    customerId: "",
    jobId: "",
    invoiceDate: new Date().toISOString().split('T')[0],
    dueDate: getDefaultDueDate(),
    items: [] as InvoiceItem[],
    designCharge: null as { amount: number; sacCode?: string; gstRate: number; totalAmount?: number } | null,
    discountAmount: 0,
    isInterState: false,
    noGst: false,
    notes: "",
    termsAndConditions: ""
  });

  useEffect(() => {
    if (open) {
      fetchCustomers();
      fetchJobs();
      fetchHsnCodes();
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
        return date.toISOString().split('T')[0];
      };

      // The job already carries its priced items — bring them in so the
      // totals are filled in. Rows stay editable, and a job with no items
      // still opens empty for manual entry.
      const items: InvoiceItem[] = (preselectedJob.items || []).map((item: any) => {
        const itemType = item.itemType === 'Square Feet' ? 'Square Feet' : 'Numbers';
        const unitPrice = item.unitPrice || 0;
        const gstRate = item.gstRate ?? 18;
        const totalAmount = itemType === 'Square Feet'
          ? (item.totalSquareFeet || 0) * unitPrice
          : (item.quantity || 0) * unitPrice;
        const gstAmount = totalAmount * (gstRate / 100);

        return {
          itemName: item.itemName || '',
          description: item.description || '',
          quantity: item.quantity || 0,
          unitPrice,
          totalAmount,
          hsnCode: item.hsnCode || '',
          gstRate,
          gstAmount,
          itemTotal: totalAmount + gstAmount,
          itemType,
          unit: item.unit || 'pieces',
          length: item.length || undefined,
          width: item.width || undefined,
          totalSquareFeet: item.totalSquareFeet || 0
        };
      });

      const newFormData = {
        customerId: preselectedJob.customerId?._id || preselectedJob.customerId || "",
        jobId: preselectedJob.id || preselectedJob._id || "",
        // A job without a due date must not blank out the field — the invoice
        // falls back to the same 30-day default it starts with.
        dueDate: formatDateForInput(preselectedJob.dueDate) || getDefaultDueDate(),
        items,
        designCharge: preselectedJob.designCharge?.amount ? preselectedJob.designCharge : null
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
      const response = await apiClient.getCustomer();
      const customersData = Array.isArray(response) ? response : (response?.customers || []);
      console.log('customersData', customersData)
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
      const response = await apiClient.getJobs();
      const jobsData = Array.isArray(response) ? response : (response?.jobs || []);
      setJobs(jobsData);
    } catch (error) {
      console.error('Error fetching jobs:', error);
    }
  };

  const fetchHsnCodes = async () => {
    try {
      const response = await apiClient.getHsnCodes();
      console.log('response is', response)
      const hsnData = Array.isArray(response) ? response : (response?.hsnCodes || []);
      setHsnCodes(hsnData);
    } catch (error) {
      console.error('Error fetching HSN codes:', error);
    }
  };

  const fetchInventoryItems = async () => {
    try {
      const response = await apiClient.getInventory();
      const inventoryData = Array.isArray(response) ? response : (response?.inventory || []);
      setInventoryItems(inventoryData);
      console.log('🔍 Inventory items loaded:', inventoryData.length);
    } catch (error) {
      console.error('Error fetching inventory items:', error);
    }
  };

  const addItem = () => {
    setFormData(prev => ({
      ...prev,
      items: [...prev.items, {
        itemName: "",
        description: "",
        quantity: 1,
        unitPrice: "" as any,
        totalAmount: 0,
        hsnCode: "",
        gstRate: 18,
        gstAmount: 0,
        itemTotal: 0,
        itemType: 'Numbers',
        unit: 'pieces',
        length: undefined,
        width: undefined,
        totalSquareFeet: 0
      }]
    }));
  };

  const removeItem = (index: number) => {
    setFormData(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index)
    }));
  };

  const updateItem = (index: number, field: keyof InvoiceItem, value: any) => {
    setFormData(prev => {
      const newItems = [...prev.items];
      const item = newItems[index];
      newItems[index] = { ...item, [field]: value };

      // Recalculate totals based on item type
      const shouldRecalculate = field === 'quantity' || field === 'unitPrice' || field === 'gstRate' ||
        field === 'length' || field === 'width' || field === 'itemType';

      if (shouldRecalculate) {
        const itemType = field === 'itemType' ? value : newItems[index].itemType;
        const unitPrice = field === 'unitPrice' ? value : newItems[index].unitPrice;
        const gstRate = field === 'gstRate' ? value : newItems[index].gstRate;

        let totalAmount = 0;

        if (itemType === 'Square Feet') {
          const length = field === 'length' ? value : newItems[index].length;
          const width = field === 'width' ? value : newItems[index].width;

          if (length && width) {
            const totalSquareFeet = length * width;
            totalAmount = totalSquareFeet * unitPrice;
            newItems[index].totalSquareFeet = totalSquareFeet;
          } else {
            totalAmount = 0;
            newItems[index].totalSquareFeet = 0;
          }
        } else {
          const quantity = field === 'quantity' ? value : newItems[index].quantity;
          totalAmount = quantity * unitPrice;
        }

        const gstAmount = totalAmount * (gstRate / 100);
        const itemTotal = totalAmount + gstAmount;

        newItems[index] = {
          ...newItems[index],
          totalAmount,
          gstAmount,
          itemTotal
        };
      }

      return { ...prev, items: newItems };
    });
  };

  // Mirrors the server: discount comes off first, GST is charged on what is
  // left, and a "No GST" invoice carries no tax at all. Keep this in step with
  // the maths in backend/src/routes/invoices.js.
  const calculateTotals = () => {
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

    // The server treats the design charge as one more taxable line (SAC 9983),
    // so it is folded in here the same way.
    const lines = [
      ...formData.items.map((item) => ({ totalAmount: item.totalAmount, gstRate: item.gstRate || 0 })),
      ...(formData.designCharge?.amount
        ? [{ totalAmount: formData.designCharge.amount, gstRate: formData.designCharge.gstRate || 0 }]
        : [])
    ];

    const subtotal = round2(lines.reduce((sum, line) => sum + line.totalAmount, 0));
    const discount = round2(Math.min(formData.discountAmount || 0, subtotal));
    const taxable = round2(subtotal - discount);

    const totalGst = formData.noGst
      ? 0
      : round2(
          lines.reduce((sum, line) => {
            const share = subtotal > 0 ? discount * (line.totalAmount / subtotal) : 0;
            return sum + (line.totalAmount - share) * (line.gstRate / 100);
          }, 0)
        );

    return { subtotal, totalGst, discount, taxable, grandTotal: round2(taxable + totalGst) };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.customerId || (formData.items.length === 0 && !formData.designCharge)) {
      toast({
        title: "Invalid Input",
        description: "Please select a customer and add at least one item",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      const invoiceData = {
        ...formData,
        items: formData.items.map(item => {
          const base = item.itemType === 'Square Feet'
            ? (item.totalSquareFeet || 0) * item.unitPrice
            : item.quantity * item.unitPrice;
          const gstAmount = base * (item.gstRate / 100);
          return {
            ...item,
            totalAmount: base,
            gstAmount,
            itemTotal: base + gstAmount
          };
        })
      };

      const response: any = await apiClient.createInvoice(invoiceData);
      console.log('📄 Advanced invoice created:', response);

      toast({
        title: "Invoice Created",
        description: "Advanced invoice has been created successfully",
      });

      onInvoiceCreated(response?.invoice || response);
      onOpenChange(false);

      // Reset form
      setFormData({
        customerId: "",
        jobId: "",
        invoiceDate: new Date().toISOString().split('T')[0],
        dueDate: getDefaultDueDate(),
        items: [],
        designCharge: null,
        discountAmount: 0,
        isInterState: false,
        noGst: false,
        notes: "",
        termsAndConditions: ""
      });
    } catch (error: any) {
      console.error('Error creating advanced invoice:', error);
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

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{preselectedJob ? 'Generate Invoice' : 'Create Invoice'}</DialogTitle>
          <DialogDescription>
            {preselectedJob
              ? 'Generate an invoice for this job — its items are filled in below and stay editable.'
              : 'Create a comprehensive invoice with line items, HSN codes, and GST calculations.'}
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
                <div className="p-3 bg-gray-50 border rounded-md">
                  <div className="font-medium text-gray-900">
                    {customers.find(c => (c._id || c.id) === formData.customerId)?.name
                      || preselectedCustomer?.name || 'Loading...'}
                  </div>
                  <div className="text-sm text-gray-600">
                    {customers.find(c => (c._id || c.id) === formData.customerId)?.email
                      || preselectedCustomer?.email || ''}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
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
                <div className="p-3 bg-gray-50 border rounded-md">
                  <div className="font-medium text-gray-900">
                    {jobs.find(j => (j._id || j.id) === formData.jobId)?.title
                      || preselectedJob?.title || 'Loading...'}
                  </div>
                  <div className="text-sm text-gray-600">
                    Customer: {(() => {
                      const j = jobs.find(job => (job._id || job.id) === formData.jobId);
                      return j?.customerId?.name || j?.customer || preselectedCustomer?.name || 'Unknown Customer';
                    })()}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
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
                  <Plus className="h-4 w-4 mr-2" />
                  Add Item
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {formData.items.map((item, index) => (
                <div key={index} className="space-y-4 p-4 border rounded-lg">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <div className="space-y-1 relative autocomplete-container">
                      <Label className="text-xs">Item Name *</Label>
                      <Input
                        value={item.itemName}
                        onChange={(e) => {
                          updateItem(index, 'itemName', e.target.value);
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
                                    const invUnit = selectedItem.unit || 'pieces';
                                    const isAreaUnit = ['sqft', 'sqm'].includes(invUnit);
                                    setFormData(prev => {
                                      const newItems = [...prev.items];
                                      newItems[index] = {
                                        ...newItems[index],
                                        itemName: selectedItem.name,
                                        unitPrice: selectedItem.unitCost || 0,
                                        hsnCode: selectedItem.hsnCode || '',
                                        gstRate: selectedItem.gstRate || 18,
                                        description: selectedItem.description || '',
                                        unit: invUnit,
                                        itemType: isAreaUnit ? 'Square Feet' : 'Numbers',
                                        length: isAreaUnit ? newItems[index].length : undefined,
                                        width: isAreaUnit ? newItems[index].width : undefined,
                                        totalSquareFeet: isAreaUnit ? (newItems[index].totalSquareFeet || 0) : 0,
                                      };
                                      if (isAreaUnit) {
                                        const l = newItems[index].length || 0;
                                        const w = newItems[index].width || 0;
                                        if (l && w) {
                                          newItems[index].totalSquareFeet = l * w;
                                          const subtotal = newItems[index].totalSquareFeet! * (selectedItem.unitCost || 0);
                                          const gstAmount = subtotal * ((selectedItem.gstRate || 18) / 100);
                                          newItems[index].totalAmount = subtotal;
                                          newItems[index].gstAmount = gstAmount;
                                          newItems[index].itemTotal = subtotal + gstAmount;
                                        } else {
                                          newItems[index].totalAmount = 0;
                                          newItems[index].gstAmount = 0;
                                          newItems[index].itemTotal = 0;
                                        }
                                      } else {
                                        const subtotal = (newItems[index].quantity || 1) * (selectedItem.unitCost || 0);
                                        const gstAmount = subtotal * ((selectedItem.gstRate || 18) / 100);
                                        newItems[index].totalAmount = subtotal;
                                        newItems[index].gstAmount = gstAmount;
                                        newItems[index].itemTotal = subtotal + gstAmount;
                                      }
                                      return { ...prev, items: newItems };
                                    });
                                    setShowSuggestions(prev => ({ ...prev, [index]: false }));
                                  }}
                                >
                                  <span className="font-medium">{selectedItem.name}</span>
                                  <span className="text-xs text-muted-foreground">
                                    Stock: {selectedItem.quantity || 0} | ₹{selectedItem.unitCost || 0}
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {item.itemType === 'Square Feet' ? (
                      <>
                        <div className="space-y-1">
                          <Label className="text-xs">Length</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={item.length || ''}
                            onChange={(e) => updateItem(index, 'length', parseFloat(e.target.value) || undefined)}
                            placeholder="Enter length"
                            min="0"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Width</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={item.width || ''}
                            onChange={(e) => updateItem(index, 'width', parseFloat(e.target.value) || undefined)}
                            placeholder="Enter width"
                            min="0"
                          />
                        </div>
                      </>
                    ) : (
                      <div className="space-y-1">
                        <Label className="text-xs">
                          {item.unit === 'boxes' ? 'Qty (Boxes)'
                            : item.unit === 'reams' ? 'Qty (Reams)'
                            : item.unit === 'kg' ? 'Qty (kg)'
                            : item.unit === 'grams' ? 'Qty (g)'
                            : item.unit === 'liters' ? 'Qty (L)'
                            : item.unit === 'meters' ? 'Qty (m)'
                            : item.unit === 'rolls' ? 'Qty (Rolls)'
                            : item.unit === 'sheets' ? 'Qty (Sheets)'
                            : 'Qty (Pcs)'}
                        </Label>
                        <Input
                          type="number"
                          value={item.quantity}
                          onChange={(e) => updateItem(index, 'quantity', parseFloat(e.target.value) || 0)}
                          min="0"
                        />
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">
                        {item.itemType === 'Square Feet'
                          ? (item.unit === 'sqm' ? 'Price/Sq M' : 'Price/Sq Ft')
                          : 'Unit Price'}
                      </Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={item.unitPrice}
                        onChange={(e) => updateItem(index, 'unitPrice', parseFloat(e.target.value) || 0)}
                        min="0"
                      />
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">HSN Code</Label>
                      <Select
                        value={item.hsnCode}
                        onValueChange={(value) => updateItem(index, 'hsnCode', value)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select HSN" />
                        </SelectTrigger>
                        <SelectContent>
                          {hsnCodes.map((hsn) => (
                            <SelectItem key={hsn._id || hsn.id} value={hsn.hsnCode}>
                              {hsn.hsnCode} - {hsn.description}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">GST %</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={item.gstRate}
                        onChange={(e) => updateItem(index, 'gstRate', parseFloat(e.target.value) || 0)}
                        min="0"
                        max="100"
                      />
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">Total</Label>
                      <div className="flex items-center space-x-1">
                        <span className="text-sm font-medium">₹{item.itemTotal.toFixed(2)}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeItem(index)}
                          className="h-8 w-8 p-0"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  {item.itemType === 'Square Feet' && item.length && item.width && (
                    <div className="text-xs text-muted-foreground bg-blue-50 p-2 rounded">
                      Area: {item.totalSquareFeet?.toFixed(2)} {item.unit === 'sqm' ? 'sq m' : 'sq ft'} ({item.length} × {item.width})
                    </div>
                  )}
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
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span>Subtotal:</span>
                  <span>₹{totals.subtotal.toFixed(2)}</span>
                </div>
                {formData.designCharge?.amount ? (
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>
                      Includes design charge (SAC {formData.designCharge.sacCode || '9983'}
                      {formData.noGst ? '' : `, GST ${formData.designCharge.gstRate || 0}%`}):
                    </span>
                    <span className="flex items-center gap-2">
                      ₹{formData.designCharge.amount.toFixed(2)}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2"
                        onClick={() => setFormData(prev => ({ ...prev, designCharge: null }))}
                      >
                        Remove
                      </Button>
                    </span>
                  </div>
                ) : null}
                <div className="flex justify-between">
                  <span>Discount:</span>
                  <span>-₹{totals.discount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Taxable Value:</span>
                  <span>₹{totals.taxable.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>{formData.noGst ? "GST (not charged):" : "GST:"}</span>
                  <span>₹{totals.totalGst.toFixed(2)}</span>
                </div>
                <Separator />
                <div className="flex justify-between font-bold text-lg">
                  <span>Grand Total:</span>
                  <span>₹{totals.grandTotal.toFixed(2)}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Additional Fields */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="noGst"
                checked={formData.noGst}
                onCheckedChange={(checked) => setFormData(prev => ({ ...prev, noGst: checked as boolean }))}
              />
              <Label htmlFor="noGst" className="font-medium cursor-pointer">
                No GST (invoice is listed with a "No GST" badge)
              </Label>
            </div>

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