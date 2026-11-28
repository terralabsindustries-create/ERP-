import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { gstinError, normalizeGstin } from "@/lib/gstin";
import { GST_STATES, stateFromGstin } from "@/lib/gstStates";
import apiClient from "@/lib/apiClient";
import { CustomerTypePicker } from "./CustomerTypePicker";

interface CreateCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the newly created customer, so a caller opening this inline can auto-select it. */
  onCustomerCreated: (customer?: any) => void;
}

export function CreateCustomerDialog({ open, onOpenChange, onCustomerCreated }: CreateCustomerDialogProps) {
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    company: "",
    address: "",
    customerType: "Walk-in",
    gstNumber: "",
    state: "",
    notes: ""
  });
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const gstProblem = gstinError(formData.gstNumber);
    if (gstProblem) {
      toast({ title: "Invalid GST number", description: gstProblem, variant: "destructive" });
      return;
    }


    if (!formData.name) {
      toast({
        title: "Invalid Input",
        description: "Customer name is required",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      const response: any = await apiClient.createCustomer({ ...formData, gstNumber: normalizeGstin(formData.gstNumber) });

      toast({
        title: "Customer Created",
        description: "Customer has been created successfully",
      });

      onCustomerCreated(response?.customer || response);
      onOpenChange(false);

      // Reset form
      setFormData({
        name: "",
        email: "",
        phone: "",
        company: "",
        address: "",
        customerType: "Walk-in",
        gstNumber: "",
    state: "",
        notes: ""
      });
    } catch (error) {
      console.error('Error creating customer:', error);

      const errorMessage =
        (error as any)?.message ||
        (typeof error === 'string' ? error : null) ||
        "Failed to create customer";

      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Customer</DialogTitle>
          <DialogDescription>
            A walk-in customer or an agency. Another customer may already have the same name.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <CustomerTypePicker value={formData.customerType} onChange={(customerType) => setFormData(prev => ({ ...prev, customerType }))} />

          <div className="space-y-2">
            <Label htmlFor="name">{formData.customerType === "Agency" ? "Agency name *" : "Customer Name *"}</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder="Enter customer name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email Address</Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
              placeholder="Enter email address (optional)"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">Phone Number</Label>
            <Input
              id="phone"
              value={formData.phone}
              onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
              placeholder="Enter phone number"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="company">Company / Business Name</Label>
            <Input
              id="company"
              value={formData.company}
              onChange={(e) => setFormData(prev => ({ ...prev, company: e.target.value }))}
              placeholder="Enter company name (optional)"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">Address</Label>
            <Textarea
              id="address"
              value={formData.address}
              onChange={(e) => setFormData(prev => ({ ...prev, address: e.target.value }))}
              placeholder="Enter customer address"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="gstNumber">GST Number</Label>
            <Input
              id="gstNumber"
              value={formData.gstNumber}
              onChange={(e) => setFormData(prev => { const gstNumber = e.target.value.toUpperCase(); return { ...prev, gstNumber, state: prev.state || stateFromGstin(gstNumber) }; })}
              placeholder="e.g. 22AAAAA0000A1Z5 (leave blank if unregistered)"
              maxLength={15}
              aria-invalid={!!gstinError(formData.gstNumber)}
            />
            {gstinError(formData.gstNumber) && (
              <p className="text-xs text-destructive" role="alert">{gstinError(formData.gstNumber)}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="state">State</Label>
            <select
              id="state"
              value={formData.state}
              onChange={(e) => setFormData(prev => ({ ...prev, state: e.target.value }))}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Select state (sets CGST+SGST or IGST)</option>
              {GST_STATES.map((st) => <option key={st.code} value={st.name}>{st.name}</option>)}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Additional notes (optional)"
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Creating..." : "Create Customer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}