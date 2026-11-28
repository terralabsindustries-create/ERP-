import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Edit, Trash2 } from "lucide-react";
import { GST_STATES, stateFromGstin } from "@/lib/gstStates";
import { gstinError, normalizeGstin } from "@/lib/gstin";
import apiClient from "@/lib/apiClient";
import { CUSTOMER_TYPES } from "@/lib/customerTypes";
import { useToast } from "@/hooks/use-toast";

interface Customer {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  customerType: string;
  gstNumber?: string;
  state?: string;
  status: string;
  tags?: string[];
}

interface EditCustomerDialogProps {
  customer: Customer | null;
  onCustomerUpdated?: () => void;
  onCustomerDeleted?: () => void;
}

export function EditCustomerDialog({ customer, onCustomerUpdated, onCustomerDeleted }: EditCustomerDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: customer?.name || "",
    email: customer?.email || "",
    phone: customer?.phone || "",
    address: customer?.address || "",
    customerType: customer?.customerType || "Individual",
    gstNumber: customer?.gstNumber || "",
    state: customer?.state || "",
    status: customer?.status || "active",
    tags: customer?.tags || []
  });
  const [selectedTags, setSelectedTags] = useState<string[]>(formData.tags);
  const { toast } = useToast();

  // Open dialog when customer prop changes
  useEffect(() => {
    if (customer) {
      setOpen(true);
      // Update form data with customer data
      setFormData({
        name: customer.name || "",
        email: customer.email || "",
        phone: customer.phone || "",
        address: customer.address || "",
        customerType: customer.customerType || "Individual",
        gstNumber: customer.gstNumber || "",
        state: customer.state || "",
        status: customer.status || "active",
        tags: customer.tags || []
      });
      setSelectedTags(customer.tags || []);
    }
  }, [customer]);

  // Don't render if customer is null or undefined
  if (!customer) {
    return null;
  }

  const availableTags = ["VIP", "Regular", "Corporate", "Walk-in", "Priority"];

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const addTag = (tag: string) => {
    if (!selectedTags.includes(tag)) {
      setSelectedTags(prev => [...prev, tag]);
    }
  };

  const removeTag = (tag: string) => {
    setSelectedTags(prev => prev.filter(t => t !== tag));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name || !formData.phone) {
      toast({
        title: "Missing Information",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    // Validate based on customer type
    // GST registration is optional (unregistered businesses are valid), but
    // anything entered must be a real GSTIN.
    const gstProblem = gstinError(formData.gstNumber);
    if (gstProblem) {
      toast({ title: "Invalid GST number", description: gstProblem, variant: "destructive" });
      return;
    }

    try {
      setLoading(true);

      // Implement API call to update customer
      const response = await apiClient.updateCustomer(customer.id, formData);
      console.log('📋 Update customer response:', response);

      toast({
        title: "Customer Updated Successfully",
        description: `${formData.name} has been updated`,
      });

      setOpen(false);
      if (onCustomerUpdated) {
        onCustomerUpdated();
      }
    } catch (error) {
      console.error('Error updating customer:', error);
      toast({
        title: "Error",
        description: "Failed to update customer",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleReactivate = async () => {
    try {
      setDeleteLoading(true);
      await apiClient.reactivateCustomer(customer.id);
      toast({ title: "Customer reactivated", description: `${customer.name} is active again` });
      setOpen(false);
      onCustomerDeleted?.();
    } catch (error) {
      toast({ title: "Could not reactivate customer", description: (error as { message?: string })?.message || "Please try again", variant: "destructive" });
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleDelete = async () => {
    setShowDeleteDialog(true);
  };

  const confirmDelete = async () => {
    try {
      setDeleteLoading(true);
      
      // Implement API call to delete customer
      const response = await apiClient.deleteCustomer(customer.id);
      console.log('📋 Delete customer response:', response);

      toast({
        title: "Customer deactivated",
        description: `${customer.name} was deactivated. Their invoices and history are kept; you can reactivate them any time.`,
      });

      setShowDeleteDialog(false);
      setOpen(false);
      
      // Immediately update customer list without page refresh
      if (onCustomerDeleted) {
        onCustomerDeleted();
      }
    } catch (error) {
      console.error('Error deleting customer:', error);
      toast({
        title: "Could not deactivate customer",
        description: (error as { message?: string })?.message || "Failed to deactivate customer",
        variant: "destructive",
      });
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[500px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Customer</DialogTitle>
            <DialogDescription>
              Update customer information and settings.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Customer Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => handleInputChange("name", e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number *</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => handleInputChange("phone", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => handleInputChange("email", e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Textarea
                id="address"
                value={formData.address}
                onChange={(e) => handleInputChange("address", e.target.value)}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="customerType">Customer Type</Label>
                <Select value={formData.customerType} onValueChange={(value) => handleInputChange("customerType", value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CUSTOMER_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select value={formData.status} onValueChange={(value) => handleInputChange("status", value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {(
              <div className="space-y-2">
                <Label htmlFor="gstNumber">GST Number</Label>
                <Input
                  id="gstNumber"
                  value={formData.gstNumber}
                  onChange={(e) => { const g = e.target.value.toUpperCase(); handleInputChange("gstNumber", g); if (!formData.state && stateFromGstin(g)) handleInputChange("state", stateFromGstin(g)); }}
                  placeholder="e.g. 22AAAAA0000A1Z5 (leave blank if unregistered)"
                  maxLength={15}
                  aria-invalid={!!gstinError(formData.gstNumber)}
                />
                {gstinError(formData.gstNumber) && (
                  <p className="text-xs text-destructive" role="alert">{gstinError(formData.gstNumber)}</p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="state">State</Label>
              <select
                id="state"
                value={formData.state}
                onChange={(e) => handleInputChange("state", e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Select state</option>
                {GST_STATES.map((st) => <option key={st.code} value={st.name}>{st.name}</option>)}
              </select>
            </div>

            <div className="space-y-2">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-2">
                {selectedTags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="cursor-pointer" onClick={() => removeTag(tag)}>
                    {tag} ×
                  </Badge>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {availableTags.filter(tag => !selectedTags.includes(tag)).map((tag) => (
                  <Badge key={tag} variant="outline" className="cursor-pointer" onClick={() => addTag(tag)}>
                    + {tag}
                  </Badge>
                ))}
              </div>
            </div>

            {duplicateWarning && (
              <div className="text-sm text-warning-strong bg-warning-soft p-2 rounded">
                {duplicateWarning}
              </div>
            )}

            <DialogFooter className="flex justify-between">
              {customer.status === "inactive" ? (
                <Button type="button" variant="outline" onClick={handleReactivate} disabled={deleteLoading}>
                  Reactivate
                </Button>
              ) : (
                <Button type="button" variant="destructive" onClick={handleDelete}>
                  <Trash2 className="h-4 w-4" />
                  Deactivate
                </Button>
              )}
              <div className="flex space-x-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? "Updating..." : "Update Customer"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      
      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate customer?</AlertDialogTitle>
            <AlertDialogDescription>
              "{customer.name}" will be deactivated, not deleted. Their invoices, jobs, quotations and payments are kept and you can reactivate them at any time. To remove a customer permanently, they must have no financial history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction 
              onClick={confirmDelete} 
              disabled={deleteLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteLoading ? "Deactivating..." : "Deactivate Customer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}