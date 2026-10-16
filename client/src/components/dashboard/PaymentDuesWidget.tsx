import { useState, useEffect } from "react";
import { format, isBefore, addDays, differenceInCalendarDays } from "date-fns";
import { Banknote, Check, IndianRupee, Phone, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/common/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { formatINR } from "@/lib/printWorkflow";
import { cn } from "@/lib/utils";

interface PaymentDue {
  _id: string;
  invoiceNumber: string;
  totalAmount: number;
  dueDate: string;
  customerId: string;
  customerName: string;
  customerGstNumber?: string;
  customerPhone?: string;
  customerAddress?: string;
  customerState?: string;
  paymentStatus: string;
  status: string;
  balanceAmount: number;
  paidAmount: number;
  invoiceDate: string;
  createdAt: string;
  updatedAt: string;
}

interface GetInvoicesResponse {
  data?: {
    invoices?: PaymentDue[];
  };
  invoices?: PaymentDue[];
}

interface PaymentDuesWidgetProps {
  onRefresh?: () => void;
}

export function PaymentDuesWidget({ onRefresh }: PaymentDuesWidgetProps) {
  const [dues, setDues] = useState<PaymentDue[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);
  const [totalDue, setTotalDue] = useState(0);
  const { toast } = useToast();

  useEffect(() => {
    fetchPaymentDues();
    // Auto-refresh every 60 seconds
    const interval = setInterval(fetchPaymentDues, 60000);
    return () => clearInterval(interval);
  }, []);

  const fetchPaymentDues = async () => {
    try {
      const response: GetInvoicesResponse = await apiClient.getInvoices({ paymentStatus: 'pending,partial,overdue' });
      console.log('💰 Payment dues response:', response);
      
      // Handle different response formats
      let duesData: PaymentDue[] = [];
      if (Array.isArray(response)) {
        duesData = response;
      } else if (response && response.data && Array.isArray(response.data.invoices)) {
        duesData = response.data.invoices;
      } else if (response && Array.isArray(response.data)) {
        duesData = response.data;
      } else if (response && Array.isArray(response.invoices)) {
        duesData = response.invoices;
      }
      
      setDues(duesData);
      
      const total = duesData.reduce((sum: number, due: PaymentDue) => sum + (due.balanceAmount ?? due.totalAmount ?? 0), 0);
      setTotalDue(total);
    } catch (error) {
      console.error('Error fetching payment dues:', error);
      toast({
        title: "Error",
        description: "Failed to load payment dues",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const getDueStatus = (dueDate: string) => {
    if (!dueDate) return { urgency: 'no-date', label: 'No due date', rank: 3 };
    
    const due = new Date(dueDate);
    const now = new Date();
    const soon = addDays(now, 3); // Next 3 days

    if (isBefore(due, now)) {
      return { urgency: 'overdue', label: 'Overdue', rank: 0 };
    } else if (isBefore(due, soon)) {
      return { urgency: 'due-soon', label: 'Due soon', rank: 1 };
    } else {
      return { urgency: 'normal', label: 'Upcoming', rank: 2 };
    }
  };

  const markAsPaid = async (invoiceId: string) => {
    const due = dues.find(d => d._id === invoiceId);
    setMarkingPaid(invoiceId);
    try {
      await apiClient.updateInvoicePaymentStatus(invoiceId, {
        paymentStatus: 'paid',
        amountPaid: due?.totalAmount || 0
      });

      // Optimistically remove from list immediately
      setDues(prev => {
        const updated = prev.filter(d => d._id !== invoiceId);
        setTotalDue(updated.reduce((sum, d) => sum + (d.balanceAmount ?? d.totalAmount ?? 0), 0));
        return updated;
      });

      toast({
        title: "Success",
        description: "Invoice marked as paid",
      });

      onRefresh?.();
    } catch (error) {
      console.error('Error updating invoice:', error);
      toast({
        title: "Error",
        description: "Failed to update invoice",
        variant: "destructive",
      });
      // Re-fetch to restore correct state on failure
      await fetchPaymentDues();
    } finally {
      setMarkingPaid(null);
    }
  };

  const rows = (Array.isArray(dues) ? dues : [])
    .map((due) => ({ due, status: getDueStatus(due.dueDate) }))
    // Overdue invoices first, then the ones falling due soonest.
    .sort(
      (a, b) =>
        a.status.rank - b.status.rank ||
        new Date(a.due.dueDate || 0).getTime() - new Date(b.due.dueDate || 0).getTime()
    );
  const overdueCount = rows.filter((r) => r.status.urgency === 'overdue').length;

  const BADGE = { overdue: 'destructive', 'due-soon': 'warning', normal: 'secondary', 'no-date': 'secondary' } as const;

  return (
    <Panel
      title="Payment dues"
      icon={IndianRupee}
      count={loading ? undefined : rows.length}
      countTone={overdueCount > 0 ? "danger" : "default"}
      description={
        loading ? (
          "Loading…"
        ) : (
          <>
            <span className="num font-semibold text-foreground">{formatINR(totalDue)}</span> outstanding
            {overdueCount > 0 && <span className="text-destructive-strong"> · {overdueCount} overdue</span>}
          </>
        )
      }
      action={
        <Button variant="ghost" size="icon-xs" onClick={fetchPaymentDues} aria-label="Refresh payment dues" className="text-muted-foreground">
          <RotateCw />
        </Button>
      }
    >
      {loading ? (
        <div className="space-y-2 p-4 sm:p-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState compact tone="success" icon={Banknote} title="All payments collected!" description="No invoices are waiting on payment." />
      ) : (
        <ul className="max-h-[22rem] divide-y overflow-y-auto">
          {rows.map(({ due, status }) => {
            const balance = due.balanceAmount ?? due.totalAmount ?? 0;
            const daysLate = due.dueDate ? differenceInCalendarDays(new Date(), new Date(due.dueDate)) : 0;
            return (
              <li
                key={due._id}
                className={cn("flex items-start gap-3 px-4 py-3 sm:px-5", status.urgency === 'overdue' && "bg-destructive-soft/40")}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{due.customerName || due.invoiceNumber}</span>
                    <Badge variant={BADGE[status.urgency as keyof typeof BADGE]}>
                      {status.urgency === 'overdue' && daysLate > 0 ? `${daysLate}d overdue` : status.label}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="font-mono">{due.invoiceNumber}</span>
                    {due.dueDate && <span>Due {format(new Date(due.dueDate), 'd MMM yyyy')}</span>}
                    {due.customerPhone && (
                      <a href={`tel:${due.customerPhone}`} className="inline-flex items-center gap-1 hover:text-foreground">
                        <Phone className="h-3 w-3" />
                        {due.customerPhone}
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <div className="num text-sm font-semibold">{formatINR(balance)}</div>
                  {balance !== due.totalAmount && due.totalAmount > 0 && (
                    <div className="num -mt-1 text-[11px] text-muted-foreground">of {formatINR(due.totalAmount)}</div>
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => markAsPaid(due._id)}
                    loading={markingPaid === due._id}
                  >
                    {markingPaid !== due._id && <Check />}
                    {markingPaid === due._id ? "Saving…" : "Mark paid"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
