import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";
import { useAuth } from "@/contexts/AuthContext";

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
  const { hasPermission } = useAuth();
  const canCreateJob = hasPermission("Jobs: Create & Edit");
  const canQuote = hasPermission("Quotations: Create & Edit");
  const canOrder = hasPermission("Inventory: Create & Edit") || hasPermission("Purchase Bills: Create & Edit");
  const canAddCustomer = hasPermission("Customers: Create & Edit");
  const [showCreateJob, setShowCreateJob] = useState(false);
  const navigate = useNavigate();
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);

  const handleJobCreated = () => {
    onJobCreated?.();
    setShowCreateJob(false);
  };

  const handleQuotationCreated = () => {
    onQuotationCreated?.();
  };

  const handleCustomerCreated = () => {
    onCustomerCreated?.();
    setShowCreateCustomer(false);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {canCreateJob && (
          <Button onClick={() => setShowCreateJob(true)} size="sm">
            <Plus />
            New Job Ticket
          </Button>
        )}

        {canQuote && (
          <CreateQuotationDialog onQuotationCreated={handleQuotationCreated}>
            <Button size="sm" variant="outline">
              <FileText />
              <span className="hidden sm:inline">Create Quotation</span>
              <span className="sm:hidden">Quotation</span>
            </Button>
          </CreateQuotationDialog>
        )}

        {(canOrder || canAddCustomer) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" aria-label="More actions">
              <MoreHorizontal />
              <span className="hidden sm:inline">More</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canOrder && (
            <DropdownMenuItem onClick={() => navigate("/purchase-orders?new=1")}>
              <ShoppingCart className="h-4 w-4" />
              Purchase Order
            </DropdownMenuItem>
            )}
            {canAddCustomer && (
            <DropdownMenuItem onClick={() => setShowCreateCustomer(true)}>
              <UserPlus className="h-4 w-4" />
              New Customer
            </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </div>

      {/* Dialogs */}
      <CreateJobDialog
        open={showCreateJob}
        onOpenChange={setShowCreateJob}
        onJobCreated={handleJobCreated}
      />

      <CreateCustomerDialog
        open={showCreateCustomer}
        onOpenChange={setShowCreateCustomer}
        onCustomerCreated={handleCustomerCreated}
      />
    </>
  );
}
