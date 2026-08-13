import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Plus, Trash2, FileText, Send, Link, UserPlus } from "lucide-react";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";

interface QuotationItem {
  item_name: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  /** Stock on hand when the item was picked, for the availability hint. */
  available_stock?: number;
  unit?: string;
}

interface CreateQuotationDialogProps {
  children: React.ReactNode;
  onQuotationCreated?: () => void;
}

export const CreateQuotationDialog = ({ children, onQuotationCreated }: CreateQuotationDialogProps) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  // Which item row's inventory suggestion list is open, if any. A typed name
  // that matches nothing is kept as-is — the backend only requires a
  // non-empty item_name, not an inventory match.
  const [openItemSuggestion, setOpenItemSuggestion] = useState<number | null>(null);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    customer_id: "",
    valid_until: "",
    gst_type: "non_gst" as "gst" | "non_gst",
    is_interstate: false,
    payment_link: "",
    terms_conditions: "",
    notes: "",
  });
  const [items, setItems] = useState<QuotationItem[]>([
    { item_name: "", description: "", quantity: 1, unit_price: 0, tax_rate: 18 }
  ]);

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
      const response = await apiClient.getCustomer();
      const customersData =
        (response as any)?.data?.customers || (response as any)?.customers || [];
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

  // Picking an inventory item fills in its price, description and GST rate, and
  // records the stock on hand so the row can warn when the quantity exceeds it.
  const selectInventoryItem = (index: number, name: string) => {
    const inv = inventoryItems.find((i) => i.name === name);
    if (!inv) return;
    const updated = [...items];
    updated[index] = {
      ...updated[index],
      item_name: inv.name,
      description: inv.description || updated[index].description,
      unit_price: inv.unitCost || 0,
      tax_rate: inv.gstRate ?? updated[index].tax_rate,
      available_stock: inv.quantity ?? 0,
      unit: inv.unit || 'pieces',
    };
    setItems(updated);
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
    setItems([...items, { item_name: "", description: "", quantity: 1, unit_price: 0, tax_rate: 18 }]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const updateItem = (index: number, field: keyof QuotationItem, value: any) => {
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], [field]: value };
    setItems(updatedItems);
  };

  const calculateTotals = () => {
    const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
    const taxAmount = formData.gst_type === "gst" ? 
      items.reduce((sum, item) => sum + (item.quantity * item.unit_price * item.tax_rate) / 100, 0) : 0;
    const total = subtotal + taxAmount;
    
    return { subtotal, taxAmount, total };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await apiClient.createQuotation({
        ...formData,
        items,
      });

      toast({
        title: "Success",
        description: "Quotation created successfully",
      });

      setOpen(false);
      setFormData({
        customer_id: "",
        valid_until: "",
        gst_type: "non_gst",
        is_interstate: false,
        payment_link: "",
        terms_conditions: "",
        notes: "",
      });
      setItems([{ item_name: "", description: "", quantity: 1, unit_price: 0, tax_rate: 18 }]);
      onQuotationCreated?.();
    } catch (error) {
      console.error('Error creating quotation:', error);
      toast({
        title: "Error",
        description: "Failed to create quotation",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const { subtotal, taxAmount, total } = calculateTotals();

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild onClick={() => { fetchCustomers(); fetchInventoryItems(); }}>
        {children}
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
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
              <SelectTrigger>
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

          {/* GST Settings */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="gst_type">GST Type</Label>
              <Select value={formData.gst_type} onValueChange={(value: "gst" | "non_gst") => 
                setFormData(prev => ({ ...prev, gst_type: value }))
              }>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="non_gst">Non-GST</SelectItem>
                  <SelectItem value="gst">GST</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            {formData.gst_type === "gst" && (
              <div className="space-y-2">
                <Label htmlFor="interstate">Transaction Type</Label>
                <Select value={formData.is_interstate ? "interstate" : "intrastate"} onValueChange={(value) => 
                  setFormData(prev => ({ ...prev, is_interstate: value === "interstate" }))
                }>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="intrastate">Intrastate</SelectItem>
                    <SelectItem value="interstate">Interstate</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

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
              <Card key={index}>
                <CardContent className="p-4">
                  <div className="grid grid-cols-6 gap-4 items-end">
                    <div className="space-y-2 relative item-name-autocomplete">
                      <Label>Item Name</Label>
                      <Input
                        value={item.item_name}
                        onChange={(e) => {
                          updateItem(index, 'item_name', e.target.value);
                          setOpenItemSuggestion(index);
                        }}
                        onFocus={() => setOpenItemSuggestion(index)}
                        placeholder="Type or pick an inventory item"
                        autoComplete="off"
                      />
                      {openItemSuggestion === index && (() => {
                        const query = item.item_name.trim().toLowerCase();
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
                                    {invItem.gstRate != null ? ` | GST ${invItem.gstRate}%` : ''}
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Input
                        value={item.description}
                        onChange={(e) => updateItem(index, 'description', e.target.value)}
                        placeholder="Description"
                      />
                    </div>
                    
                    <div className="space-y-2">
                      <Label>Quantity</Label>
                      <Input
                        type="number"
                        value={item.quantity}
                        onChange={(e) => updateItem(index, 'quantity', parseInt(e.target.value) || 0)}
                        placeholder="1"
                      />
                    </div>
                    
                    <div className="space-y-2">
                      <Label>Unit Price</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={item.unit_price}
                        onChange={(e) => updateItem(index, 'unit_price', parseFloat(e.target.value) || 0)}
                        placeholder="0.00"
                      />
                    </div>
                    
                    {formData.gst_type === "gst" && (
                      <div className="space-y-2">
                        <Label>Tax Rate (%)</Label>
                        <Input
                          type="number"
                          value={item.tax_rate}
                          onChange={(e) => updateItem(index, 'tax_rate', parseFloat(e.target.value) || 0)}
                          placeholder="18"
                        />
                      </div>
                    )}
                    
                    <div className="space-y-2">
                      <Label>Total</Label>
                      <div className="h-10 px-3 py-2 border rounded-md bg-muted flex items-center">
                        ₹{(item.quantity * item.unit_price + (formData.gst_type === "gst" ? (item.quantity * item.unit_price * item.tax_rate) / 100 : 0)).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  {item.available_stock !== undefined && (
                    <div className="mt-2 text-xs">
                      {item.quantity > item.available_stock ? (
                        // A quotation does not reserve or deduct stock, so this is a
                        // heads-up for the person quoting, not a blocker.
                        <span className="text-amber-600 font-medium">
                          Quoting {item.quantity} but only {item.available_stock}
                          {item.unit ? ` ${item.unit}` : ''} in stock — you may need to restock before invoicing.
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          In stock: {item.available_stock}{item.unit ? ` ${item.unit}` : ''}
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
                      className="mt-2 gap-2"
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
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span>Subtotal:</span>
                  <span>₹{subtotal.toFixed(2)}</span>
                </div>
                {formData.gst_type === "gst" && (
                  <div className="flex justify-between">
                    <span>Tax:</span>
                    <span>₹{taxAmount.toFixed(2)}</span>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between font-semibold">
                  <span>Total:</span>
                  <span>₹{total.toFixed(2)}</span>
                </div>
              </div>
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