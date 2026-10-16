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
import { lineAmount, lineDraftFrom, lineInput, lineProblem, newLineDraft, type LineDraft } from "@/components/billing/lineDraft";
import { documentTotals, isAreaUnit } from "@/lib/billing";

/** A line to start a quotation with, in the quotation API's terms (e.g. from the print estimator). */
export interface QuotationItem {
  item_name: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  length?: number;
  width?: number;
}

export interface CreateQuotationDialogProps {
  children: React.ReactNode;
  onQuotationCreated?: () => void;
  /** Line items to start the quotation with, e.g. from the print estimator. */
  initialItems?: QuotationItem[];
}

/** A line being quoted, with the stock on hand when an inventory item was picked. */
type QuoteLine = LineDraft & { availableStock?: number; stockUnit?: string };

export const CreateQuotationDialog = ({ children, onQuotationCreated, initialItems }: CreateQuotationDialogProps) => {
  const [open, setOpen] = useState(false);
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
    payment_link: "",
    terms_conditions: "",
    notes: "",
    design_charge: "",
  };
  const [formData, setFormData] = useState(emptyForm);
  const nextKey = useRef(1);
  const [items, setItems] = useState<QuoteLine[]>(() => [newLineDraft(nextKey.current++)]);

  const { toast } = useToast();

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

  // Picking an inventory item fills in its price and description, prices it by
  // size when the stock is counted in sq ft / sq m, and records the stock on
  // hand so the row can warn when the quantity exceeds it.
  const selectInventoryItem = (index: number, name: string) => {
    const inv = inventoryItems.find((i) => i.name === name);
    if (!inv) return;
    const unit = inv.unit || 'pieces';
    updateItem(index, {
      itemName: inv.name,
      description: inv.description || items[index].description,
      unitPrice: String(inv.unitCost || 0),
      unit,
      pricing: isAreaUnit(unit) ? unit : 'unit',
      availableStock: inv.quantity ?? 0,
      stockUnit: unit,
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

  const addItem = () => {
    setItems([...items, newLineDraft(nextKey.current++)]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  // Same arithmetic as the server: lines (area × pieces × rate for sized
  // lines) plus the design charge. No GST.
  const totals = documentTotals(items.map(lineAmount), Number(formData.design_charge) || 0);

  /** Stock used by a line, in the stock's own unit: its total area for a sized line, else its quantity. */
  const stockNeeded = (item: QuoteLine) => {
    const input = lineInput(item);
    return item.pricing !== 'unit' && item.stockUnit === item.pricing
      ? input.quantity * input.length * input.width
      : input.quantity;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const problem = !formData.customer_id
      ? "Select a customer."
      : items.map((l, i) => lineProblem(l, i + 1)).find(Boolean) || "";
    if (problem) {
      toast({ title: "Check the quotation", description: problem, variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      await apiClient.createQuotation({
        customer_id: formData.customer_id,
        valid_until: formData.valid_until,
        payment_link: formData.payment_link,
        terms_conditions: formData.terms_conditions,
        notes: formData.notes,
        design_charge: Number(formData.design_charge) || 0,
        items: items.map((l) => {
          const p = lineInput(l);
          return {
            item_name: l.itemName.trim(),
            description: l.description.trim(),
            quantity: p.quantity,
            unit: p.unit,
            unit_price: p.unitPrice,
            length: p.length,
            width: p.width
          };
        }),
      });

      toast({
        title: "Success",
        description: "Quotation created successfully",
      });

      setOpen(false);
      setFormData(emptyForm);
      setItems([newLineDraft(nextKey.current++)]);
      onQuotationCreated?.();
    } catch (error) {
      console.error('Error creating quotation:', error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create quotation",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        asChild
        onClick={() => {
          fetchCustomers();
          fetchInventoryItems();
          if (initialItems?.length) {
            setItems(
              initialItems.map((i) =>
                lineDraftFrom(nextKey.current++, { itemName: i.item_name, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unit_price, length: i.length, width: i.width })
              )
            );
          }
        }}
      >
        {children}
      </DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Create Quotation
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
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

            {items.map((item, index) => {
              const needed = stockNeeded(item);
              const sameUnit = item.stockUnit === (item.pricing === 'unit' ? item.unit : item.pricing);
              return (
              <Card key={item.key}>
                <CardContent className="space-y-3 p-4">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
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
                                    Stock: {invItem.quantity ?? 0}{invItem.unit ? ` ${invItem.unit}` : ''} | ₹{invItem.unitCost ?? 0}
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
                  </div>

                  <LinePricingFields line={item} idPrefix={`quote-${item.key}`} onChange={(patch) => updateItem(index, patch)} />

                  {item.availableStock !== undefined && (
                    <div className="text-xs">
                      {sameUnit && needed > item.availableStock ? (
                        // A quotation does not reserve or deduct stock, so this is a
                        // heads-up for the person quoting, not a blocker.
                        <span className="text-warning-strong font-medium">
                          Quoting {needed} but only {item.availableStock}
                          {item.stockUnit ? ` ${item.stockUnit}` : ''} in stock — you may need to restock before invoicing.
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          In stock: {item.availableStock}{item.stockUnit ? ` ${item.stockUnit}` : ''}
                        </span>
                      )}
                    </div>
                  )}

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
              );
            })}
          </div>

          {/* Totals */}
          <Card>
            <CardContent className="p-4">
              <BillingTotals
                totals={totals}
                idPrefix="quotation"
                designCharge={formData.design_charge}
                onDesignChargeChange={(v) => setFormData((prev) => ({ ...prev, design_charge: v }))}
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
              {loading ? "Creating..." : "Create Quotation"}
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
