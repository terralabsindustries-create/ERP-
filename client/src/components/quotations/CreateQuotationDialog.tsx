import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, Trash2, FileText, Link, UserPlus } from "lucide-react";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";
import { BillingTotals } from "@/components/billing/BillingTotals";
import { LinePricingFields } from "@/components/billing/LinePricingFields";
import { draftTotals, gstRateProblem, lineDraftFrom, lineInput, lineProblem, newLineDraft, type LineDraft } from "@/components/billing/lineDraft";
import { useHsnGstRates } from "@/components/billing/useHsnGstRates";
import { isAreaUnit } from "@/lib/billing";
import { localDate } from "@/lib/format";
import { moveFocusOnEnter } from "@/lib/formKeys";

/** A line to start a quotation with, in the quotation API's terms (e.g. from the print estimator). */
export interface QuotationItem {
  item_name: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  length?: number;
  width?: number;
  hsn_code?: string;
  tax_rate?: number;
}

/** A saved quotation, as GET /api/quotations/:id returns it, to edit. */
export interface QuotationRecord {
  _id: string;
  quotationNumber: string;
  status?: string;
  customer_id: { _id: string; name?: string } | string | null;
  valid_until?: string | null;
  shipping_address?: string;
  payment_link?: string | null;
  terms_conditions?: string;
  notes?: string;
  design_charge?: number;
  design_charge_tax_rate?: number;
  discount_amount?: number;
  is_interstate?: boolean;
  items: QuotationItem[];
}

export interface CreateQuotationDialogProps {
  /** The button that opens the dialog. Leave out when `open` is controlled. */
  children?: React.ReactNode;
  onQuotationCreated?: () => void;
  /** Line items to start the quotation with, e.g. from the print estimator. */
  initialItems?: QuotationItem[];
  /** Edit this quotation (PUT /api/quotations/:id) instead of creating one. */
  quotation?: QuotationRecord | null;
  /** Controlled open state, e.g. when editing from a row action. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called after an edit is saved. */
  onQuotationUpdated?: () => void;
}

const idOf = (value: QuotationRecord["customer_id"]): string => {
  if (!value) return "";
  return typeof value === "object" ? value._id : value;
};

// A quotation does not use stock, so unlike a job ticket or an invoice it
// does not show what is on hand.
type QuoteLine = LineDraft;

export const CreateQuotationDialog = ({
  children,
  onQuotationCreated,
  initialItems,
  quotation,
  open: openProp,
  onOpenChange,
  onQuotationUpdated
}: CreateQuotationDialogProps) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = (value: boolean) => {
    if (openProp === undefined) setUncontrolledOpen(value);
    onOpenChange?.(value);
  };
  const editing = !!quotation;
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  // Which item row's inventory suggestion list is open, if any. A typed name
  // that matches nothing is kept as-is — the backend only requires a
  // non-empty item_name, not an inventory match.
  const [openItemSuggestion, setOpenItemSuggestion] = useState<number | null>(null);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const emptyForm = {
    customer_id: "",
    valid_until: "",
    shipping_address: "",
    payment_link: "",
    terms_conditions: "",
    notes: "",
    design_charge: "",
    design_charge_tax_rate: "",
    discount_amount: "",
    is_interstate: false,
  };
  const [formData, setFormData] = useState(emptyForm);
  const nextKey = useRef(1);
  const [items, setItems] = useState<QuoteLine[]>(() => [newLineDraft(nextKey.current++)]);

  const { toast } = useToast();
  // A line given an HSN code from the HSN master starts at that code's rate.
  const hsnRate = useHsnGstRates(open);

  // Editing: start from the saved quotation each time the dialog opens, so an
  // abandoned edit is never carried into the next one.
  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !quotation) {
      prefilledFor.current = null;
      return;
    }
    if (prefilledFor.current === quotation._id) return;
    prefilledFor.current = quotation._id;
    fetchCustomers();
    fetchInventoryItems();
    setFormData({
      customer_id: idOf(quotation.customer_id),
      valid_until: quotation.valid_until ? localDate(quotation.valid_until) : "",
      shipping_address: quotation.shipping_address || "",
      payment_link: quotation.payment_link || "",
      terms_conditions: quotation.terms_conditions || "",
      notes: quotation.notes || "",
      design_charge: quotation.design_charge ? String(quotation.design_charge) : "",
      design_charge_tax_rate: quotation.design_charge ? String(quotation.design_charge_tax_rate ?? 0) : "",
      discount_amount: quotation.discount_amount ? String(quotation.discount_amount) : "",
      is_interstate: quotation.is_interstate === true
    });
    setItems(
      quotation.items.length
        ? quotation.items.map((i) =>
            lineDraftFrom(nextKey.current++, { itemName: i.item_name, description: i.description, hsnCode: i.hsn_code, quantity: i.quantity, unit: i.unit, unitPrice: i.unit_price, length: i.length, width: i.width, gstRate: i.tax_rate })
          )
        : [newLineDraft(nextKey.current++)]
    );
    // fetchCustomers / fetchInventoryItems only read setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, quotation]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!(event.target as HTMLElement)?.closest('.item-name-autocomplete')) {
        setOpenItemSuggestion(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchCustomers = async () => {
    try {
      const customersData = await apiClient.listAll('/customers', 'customers');
      setCustomers(customersData);
    } catch (error) {
      console.error('Error fetching customers:', error);
      toast({
        title: "Error",
        description: "Failed to fetch customers",
        variant: "destructive",
      });
    }
  };

  const fetchInventoryItems = async () => {
    try {
      const response = await apiClient.getInventory();
      const data = Array.isArray(response) ? response : ((response as any)?.inventory || []);
      setInventoryItems(data);
    } catch (error) {
      console.error('Error fetching inventory items:', error);
      toast({
        title: "Inventory unavailable",
        description: "Could not load inventory. You can still enter items manually.",
        variant: "destructive",
      });
    }
  };

  const updateItem = (index: number, patch: Partial<QuoteLine>) => {
    setItems((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  // Picking an inventory item fills in its price, description and HSN code,
  // and prices it by size when the stock is counted in sq ft / sq m.
  const selectInventoryItem = (index: number, name: string) => {
    const inv = inventoryItems.find((i) => i.name === name);
    if (!inv) return;
    const unit = inv.unit || 'pieces';
    const hsnCode = inv.hsnCode || items[index].hsnCode;
    updateItem(index, {
      itemName: inv.name,
      description: items[index].description || inv.description || '',
      hsnCode,
      unitPrice: String(inv.unitCost || 0),
      unit,
      pricing: isAreaUnit(unit) ? unit : 'unit',
      gstRate: items[index].gstRate || hsnRate(hsnCode),
    });
  };

  // The dialog just created a customer inline — add it to the list without a
  // refetch and select it, so the person quoting never loses their place.
  const handleCustomerCreated = (customer?: any) => {
    if (customer) {
      setCustomers((prev) => [...prev, customer]);
      setFormData((prev) => ({ ...prev, customer_id: customer._id || customer.id }));
    }
    setShowCreateCustomer(false);
  };

  // A new line starts at the rate of the line above it.
  const addItem = () => {
    setItems([...items, newLineDraft(nextKey.current++, { gstRate: items[items.length - 1]?.gstRate || "" })]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  // Same arithmetic as the server: lines (area × pieces × rate for sized
  // lines) plus the design charge, less the discount, plus GST at each rate.
  const totals = draftTotals(items, { amount: formData.design_charge, gstRate: formData.design_charge_tax_rate }, formData.discount_amount, formData.is_interstate);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const problem = !formData.customer_id
      ? "Select a customer."
      : items.map((l, i) => lineProblem(l, i + 1)).find(Boolean) ||
        (Number(formData.design_charge) > 0 ? gstRateProblem(formData.design_charge_tax_rate, "The design charge") : "") ||
        (totals.discount > totals.gross ? "The discount is more than the quotation." : "");
    if (problem) {
      toast({ title: "Check the quotation", description: problem, variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const payload = {
        customer_id: formData.customer_id,
        valid_until: formData.valid_until,
        shipping_address: formData.shipping_address,
        payment_link: formData.payment_link,
        terms_conditions: formData.terms_conditions,
        notes: formData.notes,
        design_charge: Number(formData.design_charge) || 0,
        design_charge_tax_rate: Number(formData.design_charge_tax_rate) || 0,
        discount_amount: Number(formData.discount_amount) || 0,
        is_interstate: formData.is_interstate,
        items: items.map((l) => {
          const p = lineInput(l);
          return {
            item_name: l.itemName.trim(),
            description: l.description.trim(),
            hsn_code: l.hsnCode.trim(),
            quantity: p.quantity,
            unit: p.unit,
            unit_price: p.unitPrice,
            length: p.length,
            width: p.width,
            tax_rate: p.gstRate
          };
        }),
      };

      if (quotation) {
        await apiClient.updateQuotation(quotation._id, payload);
        toast({
          title: `${quotation.quotationNumber} updated`,
          description: quotation.status === "sent" ? "The customer has the earlier version — send it again so they see the changes." : undefined,
        });
        setOpen(false);
        onQuotationUpdated?.();
        return;
      }

      await apiClient.createQuotation(payload);

      toast({
        title: "Success",
        description: "Quotation created successfully",
      });

      setOpen(false);
      setFormData(emptyForm);
      setItems([newLineDraft(nextKey.current++)]);
      onQuotationCreated?.();
    } catch (error) {
      console.error(quotation ? 'Error updating quotation:' : 'Error creating quotation:', error);
      toast({
        title: quotation ? "Quotation not saved" : "Error",
        description: error instanceof Error ? error.message : quotation ? "Failed to save the quotation" : "Failed to create quotation",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      {children && (
      <DialogTrigger
        asChild
        onClick={() => {
          fetchCustomers();
          fetchInventoryItems();
          if (initialItems?.length) {
            setItems(
              initialItems.map((i) =>
                lineDraftFrom(nextKey.current++, { itemName: i.item_name, description: i.description, hsnCode: i.hsn_code, quantity: i.quantity, unit: i.unit, unitPrice: i.unit_price, length: i.length, width: i.width, gstRate: i.tax_rate })
              )
            );
          }
        }}
      >
        {children}
      </DialogTrigger>
      )}
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            {quotation ? `Edit quotation ${quotation.quotationNumber}` : "Create Quotation"}
          </DialogTitle>
        </DialogHeader>

        {/* Enter moves between fields; only the button below saves. */}
        <form onSubmit={handleSubmit} onKeyDown={moveFocusOnEnter} className="space-y-6">
          {/* Customer Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="customer">Customer</Label>
              <Button type="button" variant="ghost" size="sm" className="gap-1 h-auto py-1" onClick={() => setShowCreateCustomer(true)}>
                <UserPlus className="w-3.5 h-3.5" />
                New Customer
              </Button>
            </div>
            <Select value={formData.customer_id} onValueChange={(value) => {
              // Radix calls this with "" to self-correct a controlled value it
              // doesn't recognize — which is exactly the state right after we
              // set customer_id to a customer just created inline, since its
              // SelectItem has never been mounted (that only happens once the
              // dropdown has been opened). Since this is a fully controlled
              // Select, Radix has no state of its own to fall back on — as
              // long as we don't act on that spurious "", the value we set
              // simply stays put. No real selection ever needs to be "".
              if (value) setFormData(prev => ({ ...prev, customer_id: value }));
            }}>
              <SelectTrigger id="customer">
                {/* Radix only resolves a label from a SelectItem that has been
                    mounted at least once (i.e. the dropdown was opened while
                    it was selected). Selecting a customer programmatically —
                    right after creating one inline — skips that, so the
                    display text is set explicitly here instead.
                    The `?? ""` matters: Radix already shows `placeholder`
                    instead of `children` whenever nothing is selected, but
                    only if `children` is *some* defined value on every
                    render. Letting it flip between undefined and a string
                    toggles an unrelated internal flag (whether the selected
                    SelectItem is allowed to portal its own text into this
                    node) and reliably crashes Radix's Portal cleanup here,
                    inside a dialog nested in another dialog. */}
                <SelectValue placeholder="Select customer">
                  {customers.find((c) => c._id === formData.customer_id)?.name ?? ""}
                </SelectValue>
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

          {formData.customer_id && (() => {
            const customer = customers.find((c) => c._id === formData.customer_id);
            if (!customer) return null;
            return (
              <div className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-3">
                <div>
                  <p className="font-semibold">Customer</p>
                  <p>{customer.name}</p>
                  {customer.phone && <p>{customer.phone}</p>}
                  {customer.email && <p className="break-all">{customer.email}</p>}
                  {customer.gstNumber && <p>GSTIN: {customer.gstNumber}</p>}
                </div>
                <div>
                  <p className="font-semibold">Billing address</p>
                  <p className="whitespace-pre-wrap">{customer.address || "Not provided"}</p>
                </div>
                <div>
                  <p className="font-semibold">Shipping address</p>
                  <p className="whitespace-pre-wrap">{formData.shipping_address || customer.address || "Not provided"}</p>
                </div>
              </div>
            );
          })()}

          <div className="space-y-2">
            <Label htmlFor="quotation-shipping-address">Shipping address (optional)</Label>
            <Textarea
              id="quotation-shipping-address"
              value={formData.shipping_address}
              onChange={(e) => setFormData((prev) => ({ ...prev, shipping_address: e.target.value }))}
              placeholder="Leave blank to use the customer's billing address"
              maxLength={1000}
              rows={2}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Valid Until */}
            <div className="space-y-2">
              <Label htmlFor="valid_until">Valid Until</Label>
              <Input
                id="valid_until"
                type="date"
                value={formData.valid_until}
                onChange={(e) => setFormData(prev => ({ ...prev, valid_until: e.target.value }))}
              />
            </div>

            {/* Payment Link */}
            <div className="space-y-2">
              <Label htmlFor="payment_link" className="flex items-center gap-2">
                <Link className="w-4 h-4" />
                Payment Link
              </Label>
              <Input
                id="payment_link"
                type="url"
                value={formData.payment_link}
                onChange={(e) => setFormData(prev => ({ ...prev, payment_link: e.target.value }))}
                placeholder="https://razorpay.com/... (optional)"
              />
            </div>
          </div>

          {/* Items */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>Items</Label>
              <Button type="button" onClick={addItem} size="sm" className="gap-2">
                <Plus className="w-4 h-4" />
                Add Item
              </Button>
            </div>

            {items.map((item, index) => (
              <Card key={item.key}>
                <CardContent className="space-y-3 p-4">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_7rem]">
                    <div className="space-y-1 relative item-name-autocomplete">
                      <Label htmlFor={`quote-item-${item.key}`} className="text-xs">Item Name</Label>
                      <Input
                        id={`quote-item-${item.key}`}
                        value={item.itemName}
                        onChange={(e) => {
                          updateItem(index, { itemName: e.target.value });
                          setOpenItemSuggestion(index);
                        }}
                        onFocus={() => setOpenItemSuggestion(index)}
                        onKeyDown={(e) => {
                          // Leaving the field by keyboard closes its suggestions.
                          if (e.key === "Enter" || e.key === "Tab") setOpenItemSuggestion(null);
                        }}
                        placeholder="Type or pick an inventory item"
                        autoComplete="off"
                      />
                      {openItemSuggestion === index && (() => {
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
                              matches.map((invItem) => (
                                <button
                                  type="button"
                                  key={invItem._id || invItem.id}
                                  className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                                  onClick={() => {
                                    selectInventoryItem(index, invItem.name);
                                    setOpenItemSuggestion(null);
                                  }}
                                >
                                  <span className="font-medium">{invItem.name}</span>
                                  <span className="text-xs text-muted-foreground">
                                    ₹{invItem.unitCost ?? 0}{invItem.unit ? ` per ${invItem.unit}` : ''}
                                    {invItem.hsnCode ? ` · HSN ${invItem.hsnCode}` : ''}
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor={`quote-desc-${item.key}`} className="text-xs">Description</Label>
                      <Input
                        id={`quote-desc-${item.key}`}
                        value={item.description}
                        onChange={(e) => updateItem(index, { description: e.target.value })}
                        placeholder="Description"
                      />
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor={`quote-hsn-${item.key}`} className="text-xs">HSN code</Label>
                      <Input
                        id={`quote-hsn-${item.key}`}
                        value={item.hsnCode}
                        onChange={(e) => {
                          const hsnCode = e.target.value.replace(/\D/g, '').slice(0, 8);
                          updateItem(index, { hsnCode, ...(item.gstRate ? {} : { gstRate: hsnRate(hsnCode) }) });
                        }}
                        inputMode="numeric"
                        placeholder="Optional"
                      />
                    </div>
                  </div>

                  <LinePricingFields line={item} idPrefix={`quote-${item.key}`} onChange={(patch) => updateItem(index, patch)} />

                  {items.length > 1 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => removeItem(index)}
                      className="gap-2"
                    >
                      <Trash2 className="w-4 h-4" />
                      Remove
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Totals */}
          <Card>
            <CardContent className="p-4">
              <BillingTotals
                totals={totals}
                idPrefix="quotation"
                designCharge={formData.design_charge}
                onDesignChargeChange={(v) => setFormData((prev) => ({ ...prev, design_charge: v }))}
                designChargeGstRate={formData.design_charge_tax_rate}
                onDesignChargeGstRateChange={(v) => setFormData((prev) => ({ ...prev, design_charge_tax_rate: v }))}
                isInterState={formData.is_interstate}
                onInterStateChange={(v) => setFormData((prev) => ({ ...prev, is_interstate: v }))}
                discount={formData.discount_amount}
                onDiscountChange={(v) => setFormData((prev) => ({ ...prev, discount_amount: v }))}
                totalLabel="Quotation total"
              />
            </CardContent>
          </Card>

          {/* Terms and Notes */}
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

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Additional notes"
              rows={3}
            />
          </div>

          {/* Submit Button */}
          <div className="flex justify-end space-x-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? (editing ? "Saving..." : "Creating...") : editing ? "Save changes" : "Create Quotation"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    <CreateCustomerDialog
      open={showCreateCustomer}
      onOpenChange={setShowCreateCustomer}
      onCustomerCreated={handleCustomerCreated}
    />
    </>
  );
};
