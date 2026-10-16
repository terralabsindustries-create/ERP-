import { useEffect, useState } from "react";
import { CheckCircle2, MessageCircle, Phone, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { CounterJob, Operator } from "@/lib/api/walkIn";
import { cn } from "@/lib/utils";
import { fmtPhone, operatorName, readyWhatsAppLink, telLink } from "./counterJobMeta";

const UNASSIGNED = "__none__";

/** Give a job to one of the business's logins, or take it off them. */
export function AssignOperatorDialog({
  job,
  operators,
  onOpenChange,
  onAssign
}: {
  job: CounterJob | null;
  operators: Operator[];
  onOpenChange: (open: boolean) => void;
  onAssign: (job: CounterJob, operatorId: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(UNASSIGNED);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (job) setValue(job.assignedTo?.operator?._id || UNASSIGNED);
  }, [job]);

  const save = async () => {
    if (!job) return;
    setBusy(true);
    try {
      await onAssign(job, value === UNASSIGNED ? null : value);
      onOpenChange(false);
    } catch {
      /* the caller shows the error; keep the dialog open */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!job} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign operator</DialogTitle>
          <DialogDescription>{job ? `${job.jobNumber} · ${job.description}` : null}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="assign-operator">Operator</Label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger id="assign-operator">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>Not assigned</SelectItem>
              {operators.length > 0 && <SelectSeparator />}
              {operators.map((o) => (
                <SelectItem key={o._id} value={o._id}>
                  {o.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {job && operatorName(job) && <p className="text-xs text-muted-foreground">Now with {operatorName(job)}.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Record the check: pass makes the job ready for pickup, fail sends it back with a note. */
export function QualityCheckDialog({
  job,
  onOpenChange,
  onRecord
}: {
  job: CounterJob | null;
  onOpenChange: (open: boolean) => void;
  onRecord: (job: CounterJob, passed: boolean, notes: string) => Promise<void>;
}) {
  const [passed, setPassed] = useState<boolean | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (job) {
      setPassed(null);
      setNotes("");
      setError("");
    }
  }, [job]);

  const save = async () => {
    if (!job) return;
    if (passed === null) return setError("Choose pass or fail.");
    if (!passed && !notes.trim()) return setError("Say what needs fixing.");
    setBusy(true);
    try {
      await onRecord(job, passed, notes.trim());
      onOpenChange(false);
    } catch {
      /* reported by the caller */
    } finally {
      setBusy(false);
    }
  };

  const choice = (value: boolean, label: string, hint: string, Icon: typeof CheckCircle2) => (
    <button
      type="button"
      onClick={() => {
        setPassed(value);
        setError("");
      }}
      aria-pressed={passed === value}
      className={cn(
        "flex flex-1 items-start gap-2.5 rounded-lg border p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        passed === value && (value ? "border-success bg-success-soft/50" : "border-destructive bg-destructive-soft/50")
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", value ? "text-success-strong" : "text-destructive-strong")} />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );

  return (
    <Dialog open={!!job} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Quality check</DialogTitle>
          <DialogDescription>{job ? `${job.jobNumber} · ${job.description}` : null}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            {choice(true, "Pass", "Ready for pickup", CheckCircle2)}
            {choice(false, "Fail", "Back to production", XCircle)}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qc-notes">{passed === false ? "What needs fixing" : "Note"}</Label>
            <Textarea
              id="qc-notes"
              rows={3}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setError("");
              }}
              placeholder={passed === false ? "e.g. Colours washed out on 20 sheets" : "Optional"}
            />
          </div>
          {error && <p className="text-sm text-destructive-strong">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} variant={passed === false ? "destructive" : "default"}>
            {passed === false ? "Send back" : "Record check"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shown when a job becomes ready: tell the customer by WhatsApp or a call. */
export function ReadyDialog({ job, businessName, onOpenChange }: { job: CounterJob | null; businessName?: string; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={!!job} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ready for pickup</DialogTitle>
          <DialogDescription>
            {job ? `${job.jobNumber} is ready. Let ${job.customerName} know on ${fmtPhone(job.customerPhone)}.` : null}
          </DialogDescription>
        </DialogHeader>
        {job && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild variant="success" className="flex-1">
              <a href={readyWhatsAppLink(job, businessName)} target="_blank" rel="noopener noreferrer">
                <MessageCircle />
                WhatsApp customer
              </a>
            </Button>
            <Button asChild variant="outline" className="flex-1">
              <a href={telLink(job.customerPhone)}>
                <Phone />
                Call customer
              </a>
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
