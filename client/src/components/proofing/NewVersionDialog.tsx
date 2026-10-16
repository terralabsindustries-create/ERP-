import { useEffect, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { proofsApi, uploadProofFiles, type Proof, type UploadedFile } from "@/lib/api/proofs";
import { FilePicker } from "./FilePicker";
import { jobIdOf, jobTitleOf } from "./proofMeta";

/**
 * Upload corrected artwork. The current files move to the version history and
 * the proof goes back to the customer (or stays a draft).
 */
export function NewVersionDialog({ proof, onOpenChange, onDone }: { proof: Proof | null; onOpenChange: (open: boolean) => void; onDone: (proof: Proof, sent: boolean) => void }) {
  const { toast } = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [notes, setNotes] = useState("");
  const [send, setSend] = useState(true);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const uploaded = useRef(new WeakMap<File, UploadedFile>());

  useEffect(() => {
    if (proof) {
      setFiles([]);
      setNotes(proof.status === "rejected" && proof.approval?.rejectionReason ? `Changed as asked: ${proof.approval.rejectionReason}` : "");
      setSend(true);
      uploaded.current = new WeakMap();
    }
  }, [proof]);

  const next = (proof?.version || 0) + 1;

  const save = async () => {
    if (!proof) return;
    if (!files.length) {
      toast({ title: "Add the corrected file", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const done = await uploadProofFiles(files, { _id: jobIdOf(proof), title: jobTitleOf(proof) }, (current, total) => setProgress({ current, total }), uploaded.current);
      setProgress(null);
      const updated = await proofsApi.newVersion(proof._id, { files: done.map((f) => ({ fileId: f._id })), notes: notes.trim(), send });
      toast({ title: `Version ${updated.version} uploaded`, description: send ? "Marked as sent. Share it with the customer next." : "Saved as a draft." });
      onDone(updated, send);
      onOpenChange(false);
    } catch (error) {
      toast({ title: "New version not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  return (
    <Dialog open={!!proof} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload version {next}</DialogTitle>
          <DialogDescription>
            {proof ? `${proof.proofNumber} · ${proof.title}. Version ${proof.version} moves to the history.` : null}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FilePicker id="version-files" files={files} onChange={setFiles} disabled={saving} />
          <div className="space-y-1.5">
            <Label htmlFor="version-notes">What changed</Label>
            <Textarea id="version-notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional, shown in the history and the message" />
          </div>
          <label htmlFor="version-send" className="flex items-start gap-2.5 text-sm">
            <Checkbox id="version-send" checked={send} onCheckedChange={(v) => setSend(v === true)} className="mt-0.5" />
            <span>
              Mark as sent to the customer
              <span className="block text-xs text-muted-foreground">Leave unticked to keep it as a draft until you send it.</span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Upload />}
            {saving ? (progress ? `Uploading ${progress.current} of ${progress.total}…` : "Saving…") : `Upload version ${next}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
