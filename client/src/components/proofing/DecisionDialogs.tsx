import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, MessageSquareWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { proofsApi, type ApprovalChannel, type Proof } from "@/lib/api/proofs";
import { APPROVAL_CHANNELS, jobTitleOf } from "./proofMeta";

interface DecisionProps {
  proof: Proof | null;
  onOpenChange: (open: boolean) => void;
  onDone: (proof: Proof) => void;
}

const subtitle = (p: Proof) => `${p.proofNumber} · version ${p.version} · ${p.customerName} · ${jobTitleOf(p)}`;

/** Record that the customer approved the current version. */
export function ApproveDialog({ proof, onOpenChange, onDone }: DecisionProps) {
  const { toast } = useToast();
  const [approvedByName, setApprovedByName] = useState("");
  const [channel, setChannel] = useState<ApprovalChannel>("whatsapp");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (proof) {
      setApprovedByName("");
      setChannel(proof.notifications?.sentVia === "email" ? "email" : proof.notifications?.sentVia === "in_person" ? "in_person" : "whatsapp");
      setNotes("");
    }
  }, [proof]);

  const save = async () => {
    if (!proof) return;
    setSaving(true);
    try {
      const updated = await proofsApi.approve(proof._id, { approvedByName: approvedByName.trim(), channel, approvalNotes: notes.trim() });
      toast({ title: `${proof.proofNumber} approved`, description: "The job can go to press." });
      onDone(updated);
      onOpenChange(false);
    } catch (error) {
      toast({ title: "Approval not recorded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!proof} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record approval</DialogTitle>
          <DialogDescription>{proof ? subtitle(proof) : null}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="approve-by">Approved by</Label>
            <Input id="approve-by" value={approvedByName} maxLength={120} onChange={(e) => setApprovedByName(e.target.value)} placeholder={proof?.customerName || "Name"} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="approve-channel">How they approved</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as ApprovalChannel)}>
              <SelectTrigger id="approve-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(APPROVAL_CHANNELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="approve-notes">Notes</Label>
            <Textarea id="approve-notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional, e.g. approved on WhatsApp at 4:10 pm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            Record approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Record that the customer asked for changes; the reason is required. */
export function RequestChangesDialog({ proof, onOpenChange, onDone }: DecisionProps) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (proof) setReason("");
  }, [proof]);

  const save = async () => {
    if (!proof) return;
    if (!reason.trim()) {
      toast({ title: "Write what the customer wants changed", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const updated = await proofsApi.reject(proof._id, reason.trim());
      toast({ title: "Changes recorded", description: "Upload a new version when the artwork is corrected." });
      onDone(updated);
      onOpenChange(false);
    } catch (error) {
      toast({ title: "Not recorded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!proof} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Changes requested</DialogTitle>
          <DialogDescription>{proof ? subtitle(proof) : null}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="changes-reason">What should change?</Label>
          <Textarea
            id="changes-reason"
            rows={4}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Phone number is wrong, make the logo bigger"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !reason.trim()}>
            {saving ? <Loader2 className="animate-spin" /> : <MessageSquareWarning />}
            Record changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
