import { useEffect, useState } from "react";
import { Copy, Download, Loader2, MessageCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { downloadProofFile, proofsApi, type Proof, type SendChannel } from "@/lib/api/proofs";
import { SEND_CHANNELS, customerPhoneOf, fmtPhone, proofMessage, waLink, waNumber } from "./proofMeta";

/**
 * Send a proof to the customer. Nothing is sent from here: it prepares the
 * message for WhatsApp (or to copy), offers the files to attach, and — when
 * `markSent` — records that the proof went out.
 */
export function ShareProofDialog({
  proof,
  open,
  onOpenChange,
  markSent,
  onSent
}: {
  proof: Proof | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Show "Mark as sent" (for drafts); otherwise it only helps re-share. */
  markSent: boolean;
  onSent?: (proof: Proof) => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  const [via, setVia] = useState<SendChannel>("whatsapp");
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const phone = proof ? customerPhoneOf(proof) : "";
  const canWhatsApp = !!waNumber(phone);

  useEffect(() => {
    if (open && proof) {
      setMessage(proofMessage(proof, user?.companyName));
      setVia(waNumber(customerPhoneOf(proof)) ? "whatsapp" : "other");
    }
  }, [open, proof, user?.companyName]);

  if (!proof) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast({ title: "Message copied" });
    } catch {
      toast({ title: "Copy did not work", description: "Select the message and copy it by hand.", variant: "destructive" });
    }
  };

  const downloadAll = async () => {
    setDownloading(true);
    try {
      for (const f of proof.files) await downloadProofFile(f);
    } catch (error) {
      toast({ title: "Download failed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const confirm = async () => {
    setSaving(true);
    try {
      const updated = await proofsApi.send(proof._id, via);
      toast({ title: `${proof.proofNumber} marked as sent`, description: `Waiting for ${proof.customerName} to reply.` });
      onSent?.(updated);
      onOpenChange(false);
    } catch (error) {
      toast({ title: "Not marked as sent", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{markSent ? "Send to customer" : "Share with customer"}</DialogTitle>
          <DialogDescription>
            {proof.proofNumber} · version {proof.version} · {proof.customerName}
            {phone ? ` · ${fmtPhone(phone)}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="share-message">Message</Label>
            <Textarea id="share-message" rows={10} value={message} onChange={(e) => setMessage(e.target.value)} className="text-sm" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              <Copy />
              Copy message
            </Button>
            {canWhatsApp ? (
              <Button type="button" variant="outline" size="sm" asChild>
                <a href={waLink(phone, message)} target="_blank" rel="noopener noreferrer" onClick={() => setVia("whatsapp")}>
                  <MessageCircle />
                  Open WhatsApp
                </a>
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" disabled>
                <MessageCircle />
                No phone number
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={downloadAll} disabled={downloading || !proof.files.length}>
              {downloading ? <Loader2 className="animate-spin" /> : <Download />}
              {proof.files.length === 1 ? "Download file" : `Download ${proof.files.length} files`}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {canWhatsApp
              ? "WhatsApp opens with this message filled in. Attach the proof file in the chat before sending."
              : "This customer has no usable phone number. Add one on the customer to send by WhatsApp, or copy the message."}
          </p>
          {markSent && (
            <div className="space-y-1.5 border-t pt-3">
              <Label htmlFor="share-via">Sent by</Label>
              <Select value={via} onValueChange={(v) => setVia(v as SendChannel)}>
                <SelectTrigger id="share-via" className="sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SEND_CHANNELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          {markSent ? (
            <>
              <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
                Not yet
              </Button>
              <Button type="button" disabled={saving} onClick={confirm}>
                {saving ? <Loader2 className="animate-spin" /> : <Send />}
                Mark as sent
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
