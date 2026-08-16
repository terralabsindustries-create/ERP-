import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Plus,
  FileText,
  ShoppingCart,
  UserPlus,
  MoreHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CreateJobDialog } from "@/components/jobs/CreateJobDialog";
import { CreateQuotationDialog } from "@/components/quotations/CreateQuotationDialog";
import { PurchaseOrderDialog } from "@/components/inventory/PurchaseOrderDialog";
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";

interface DashboardShortcutsProps {
  onJobCreated?: () => void;
  onQuotationCreated?: () => void;
  onOrderCreated?: () => void;
  onCustomerCreated?: () => void;
}

export function DashboardShortcuts({
  onJobCreated,
  onQuotationCreated,
  onOrderCreated,
  onCustomerCreated
}: DashboardShortcutsProps) {
  const [showCreateJob, setShowCreateJob] = useState(false);
  const [showPurchaseOrder, setShowPurchaseOrder] = useState(false);
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);

  const handleJobCreated = () => {
    onJobCreated?.();
    setShowCreateJob(false);
  };

  const handleQuotationCreated = () => {
    onQuotationCreated?.();
  };

  const handleOrderCreated = () => {
    onOrderCreated?.();
    setShowPurchaseOrder(false);
  };

  const handleCustomerCreated = () => {
    onCustomerCreated?.();
    setShowCreateCustomer(false);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setShowCreateJob(true)} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Quick Job
        </Button>

        <CreateQuotationDialog onQuotationCreated={handleQuotationCreated}>
          <Button size="sm" variant="outline" className="gap-2">
            <FileText className="h-4 w-4" />
            Create Quotation
          </Button>
        </CreateQuotationDialog>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="gap-2">
              <MoreHorizontal className="h-4 w-4" />
              More
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setShowPurchaseOrder(true)}>
              <ShoppingCart className="h-4 w-4 mr-2" />
              Purchase Order
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShowCreateCustomer(true)}>
              <UserPlus className="h-4 w-4 mr-2" />
              New Customer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Dialogs */}
      <CreateJobDialog
        open={showCreateJob}
        onOpenChange={setShowCreateJob}
        onJobCreated={handleJobCreated}
      />

      <PurchaseOrderDialog
        open={showPurchaseOrder}
        onOpenChange={setShowPurchaseOrder}
        onOrderCreated={handleOrderCreated}
      />

      <CreateCustomerDialog
        open={showCreateCustomer}
        onOpenChange={setShowCreateCustomer}
        onCustomerCreated={handleCustomerCreated}
      />
    </>
  );
}
