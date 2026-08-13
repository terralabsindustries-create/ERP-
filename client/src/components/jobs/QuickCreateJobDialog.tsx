import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";

interface QuickCreateJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reuses the caller's already-fetched customer list rather than fetching its own. */
  customers: any[];
  /** Receives the newly created job, so a caller opening this inline can auto-select it. */
  onJobCreated: (job?: any) => void;
}

/**
 * A minimal job-creation form for opening inline from another dialog (e.g.
 * picking a job while creating an invoice). `CreateJobDialog` covers the full
 * workflow — line items, design charges, an invoice follow-up prompt — none of
 * which make sense stacked on top of a dialog the user is already creating an
 * invoice from. Only `title` and `customerId` are actually required by the
 * API; everything else here is optional, matching the backend's own defaults.
 */
export function QuickCreateJobDialog({ open, onOpenChange, customers, onJobCreated }: QuickCreateJobDialogProps) {
  const [formData, setFormData] = useState({
    title: "",
    customerId: "",
    priority: "medium" as 'low' | 'medium' | 'high' | 'urgent',
    dueDate: "",
  });
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.title.trim() || !formData.customerId) {
      toast({
        title: "Invalid Input",
        description: "Job title and customer are required",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      const response: any = await apiClient.createJob({
        title: formData.title.trim(),
        customerId: formData.customerId,
        priority: formData.priority,
        dueDate: formData.dueDate || null,
      });

      toast({
        title: "Job Created",
        description: "Job has been created successfully",
      });

      const job = response?.job || response;
      // Normalize to the flat `customer` name shape this dialog's job list
      // already uses (from GET /jobs), rather than the populated `customerId`
      // object the create endpoint returns — so the new entry renders the same
      // as every other job in the dropdown.
      const customerName = customers.find((c) => (c._id || c.id) === formData.customerId)?.name;
      onJobCreated({ ...job, customer: customerName || job?.customerId?.name });
      onOpenChange(false);
      setFormData({ title: "", customerId: "", priority: "medium", dueDate: "" });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error?.message || "Failed to create job",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add New Job</DialogTitle>
          <DialogDescription>
            Add a new job to link this invoice to. Items and pricing can be filled in later from the Jobs page.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="job-title">Job Title *</Label>
            <Input
              id="job-title"
              value={formData.title}
              onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
              placeholder="Enter job title"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="job-customer">Customer *</Label>
            <Select
              value={formData.customerId}
              onValueChange={(value) => setFormData((prev) => ({ ...prev, customerId: value }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select customer" />
              </SelectTrigger>
              <SelectContent>
                {customers.map((customer) => (
                  <SelectItem key={customer._id || customer.id} value={customer._id || customer.id}>
                    {customer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="job-priority">Priority</Label>
              <Select
                value={formData.priority}
                onValueChange={(value: 'low' | 'medium' | 'high' | 'urgent') =>
                  setFormData((prev) => ({ ...prev, priority: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="job-dueDate">Due Date</Label>
              <Input
                id="job-dueDate"
                type="date"
                value={formData.dueDate}
                onChange={(e) => setFormData((prev) => ({ ...prev, dueDate: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Creating..." : "Create Job"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
