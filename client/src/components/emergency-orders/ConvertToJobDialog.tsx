import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtPhone } from "@/components/delivery/deliveryMeta";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { formatINR } from "@/lib/format";
import { rushOrdersApi, type CustomerOption, type RushOrder } from "@/lib/api/rushOrders";
import { compactPhone, customerIdOf, jobTitleFrom, phoneKey } from "./rushMeta";

type Step = "idle" | "customer" | "job" | "link";
const STEP_LABEL: Record<Step, string> = { idle: "", customer: "Adding the customer…", job: "Creating the job…", link: "Linking it to the order…" };

/**
 * Turns a rush order into a real job: finds the customer by phone (or adds
 * them), creates the job through the jobs API, then links it to the order.
 */
export function ConvertToJobDialog({ order: orderProp, onClose, onConverted }: { order: RushOrder | null; onClose: () => void; onConverted: (o: RushOrder, jobTitle: string) => void }) {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  // Keep showing the last order while the dialog animates closed.
  const last = useRef<RushOrder | null>(null);
  if (orderProp) last.current = orderProp;
  const open = !!orderProp;
  const order = last.current;
  const canAddCustomer = hasPermission("Customers: Create & Edit");
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [finding, setFinding] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  // A job already created whose link failed, so a retry doesn't create a second one.
  const [createdJob, setCreatedJob] = useState<{ _id: string; title: string } | null>(null);

  useEffect(() => {
    if (!open || !order) return;
    setTitle(jobTitleFrom(order));
    setDueDate(order.expectedCompletion ? format(new Date(order.expectedCompletion), "yyyy-MM-dd") : "");
    setError(null);
    setStep("idle");
    setCreatedJob(null);
    setCustomer(null);
    setFinding(true);
    const linkedId = customerIdOf(order);
    rushOrdersApi
      .customers()
      .then((all) => {
        const key = phoneKey(order.customerPhone);
        setCustomer(all.find((c) => c._id === linkedId) || (key.length === 10 ? all.find((c) => phoneKey(c.phone) === key) : undefined) || null);
      })
      .catch(() => setCustomer(null))
      .finally(() => setFinding(false));
  }, [open, order]);

  if (!order) return null;

  const busy = step !== "idle";
  const needsNewCustomer = !finding && !customer;
  const blocked = needsNewCustomer && !canAddCustomer;

  const convert = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError("Enter a title for the job");
    setError(null);
    let job = createdJob;
    const at: { stage: Step } = { stage: "idle" };
    const go = (next: Step) => {
      at.stage = next;
      setStep(next);
    };
    try {
      if (!job) {
        let customerId = customer?._id;
        if (!customerId) {
          go("customer");
          const c = await rushOrdersApi.createCustomer({ name: order.customerName, phone: compactPhone(order.customerPhone), ...(order.customerEmail ? { email: order.customerEmail } : {}) });
          setCustomer(c);
          customerId = c._id;
        }
        go("job");
        const notes = [`From rush order ${order.orderId}.`, order.advancePaid ? `Advance received: ${formatINR(order.advancePaid)}.` : "", order.notes || ""].filter(Boolean).join(" ");
        job = await rushOrdersApi.createJob({
          title: title.trim(),
          customerId,
          description: order.orderDetails,
          priority: order.priority,
          dueDate: dueDate ? new Date(`${dueDate}T00:00:00`).toISOString() : undefined,
          estimatedCost: order.estimatedAmount,
          notes
        });
        setCreatedJob(job);
      }
      go("link");
      const linked = await rushOrdersApi.linkJob(order._id, job._id);
      toast({ title: "Converted to a job", description: `${order.orderId} is now the job "${job.title}".` });
      onConverted(linked, job.title);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setError(at.stage === "link" ? `The job was created but not linked to the order: ${message}. Try again to link it.` : message);
    } finally {
      setStep("idle");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={convert} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Convert to job</DialogTitle>
            <DialogDescription>
              Creates a job ticket for {order.orderId} so it goes through the normal workflow. The rush order is closed as converted.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="cv-title">Job title</Label>
            <Input id="cv-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!!createdJob} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cv-due">Due date</Label>
            <Input id="cv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={!!createdJob} />
          </div>

          <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Customer</div>
            {finding ? (
              <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Looking for {fmtPhone(order.customerPhone)}…
              </div>
            ) : customer ? (
              <div className="mt-1">
                <span className="font-medium">{customer.name}</span>
                <span className="text-muted-foreground"> · {fmtPhone(customer.phone) || "saved customer"}</span>
              </div>
            ) : (
              <div className="mt-1">
                <span className="font-medium">{order.customerName}</span>
                <span className="text-muted-foreground"> · {fmtPhone(order.customerPhone)}</span>
                <div className={blocked ? "text-destructive-strong" : "text-muted-foreground"}>
                  {blocked ? "Not in Customers yet, and your login can't add customers. Ask someone who can, or pick a saved customer on the order." : "Not in Customers yet — they'll be added."}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Estimated amount</div>
              <div className="num font-medium">{formatINR(order.estimatedAmount)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Advance paid</div>
              <div className="num font-medium">{formatINR(order.advancePaid || 0)}</div>
            </div>
          </div>

          {error && <p className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive-strong">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || finding || blocked}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? STEP_LABEL[step] : createdJob ? "Link the job" : "Create job"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
