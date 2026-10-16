import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { deliveriesApi, type Delivery, type TimeSlot } from "@/lib/api/deliveries";
import { TIME_SLOTS, dateOnly, isPhone, localToday, slotLabel } from "./deliveryMeta";

export type StatusMode = "dispatch" | "deliver" | "fail" | "reschedule";

const FAIL_REASONS = ["Customer not available", "Address not found", "Premises closed", "Customer refused", "Vehicle problem"];

const TITLE: Record<StatusMode, string> = { dispatch: "Dispatch", deliver: "Mark delivered", fail: "Mark failed", reschedule: "Reschedule" };
const tomorrow = () => format(new Date(Date.now() + 864e5), "yyyy-MM-dd");
const nowLocal = () => format(new Date(), "yyyy-MM-dd'T'HH:mm");

/**
 * The status steps of a delivery, each with what it needs: the driver to
 * dispatch, who received it, why it failed (and optionally a new date), or a
 * new date to try again.
 */
export function DeliveryStatusDialog({
  delivery: deliveryProp,
  mode: modeProp,
  onClose,
  onDone
}: {
  delivery: Delivery | null;
  mode: StatusMode | null;
  onClose: () => void;
  onDone: (d: Delivery) => void;
}) {
  const { toast } = useToast();
  // Keep showing the last delivery while the dialog animates closed.
  const last = useRef<{ delivery: Delivery; mode: StatusMode } | null>(null);
  if (deliveryProp && modeProp) last.current = { delivery: deliveryProp, mode: modeProp };
  const open = !!(deliveryProp && modeProp);
  const delivery = last.current?.delivery || null;
  const mode = last.current?.mode || null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [driver, setDriver] = useState({ name: "", phone: "", vehicleNumber: "" });
  const [receivedBy, setReceivedBy] = useState("");
  const [deliveredAt, setDeliveredAt] = useState(nowLocal);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [reschedule, setReschedule] = useState(true);
  const [newDate, setNewDate] = useState(tomorrow);
  const [slot, setSlot] = useState<TimeSlot>("Flexible");

  useEffect(() => {
    if (!open || !delivery || !mode) return;
    setError(null);
    setDriver({ name: delivery.driverInfo?.name || "", phone: delivery.driverInfo?.phone || "", vehicleNumber: delivery.driverInfo?.vehicleNumber || "" });
    setReceivedBy(delivery.contactInfo?.name || "");
    setDeliveredAt(nowLocal());
    setNote("");
    setReason("");
    setReschedule(true);
    setNewDate(tomorrow());
    setSlot(delivery.deliveryTimeSlot || "Flexible");
  }, [open, delivery, mode]);

  if (!delivery || !mode) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const today = localToday();
    if (mode === "dispatch") {
      if (!driver.name.trim()) return setError("Enter the driver's name");
      if (driver.phone.trim() && !isPhone(driver.phone)) return setError("Enter a valid phone number for the driver");
    }
    if (mode === "deliver") {
      if (!receivedBy.trim()) return setError("Enter who received it");
      if (!deliveredAt) return setError("Enter when it was delivered");
      if (new Date(deliveredAt).getTime() > Date.now() + 60e3) return setError("The delivery time can't be in the future");
    }
    if (mode === "fail" && !reason.trim()) return setError("Say why it failed");
    if ((mode === "reschedule" || (mode === "fail" && reschedule)) && (!newDate || newDate < today)) return setError("Choose a new date from today on");

    setBusy(true);
    try {
      let saved: Delivery;
      if (mode === "dispatch") {
        saved = await deliveriesApi.setStatus(delivery._id, {
          status: "in_transit",
          driverInfo: { name: driver.name.trim(), phone: driver.phone.trim() || undefined, vehicleNumber: driver.vehicleNumber.trim() || undefined },
          note: note.trim() || undefined
        });
        toast({ title: `${delivery.deliveryId} dispatched`, description: `With ${driver.name.trim()}` });
      } else if (mode === "deliver") {
        saved = await deliveriesApi.setStatus(delivery._id, { status: "delivered", receivedBy: receivedBy.trim(), deliveredAt: new Date(deliveredAt).toISOString(), note: note.trim() || undefined });
        toast({ title: `${delivery.deliveryId} delivered`, description: `Received by ${receivedBy.trim()}` });
      } else if (mode === "fail") {
        saved = await deliveriesApi.setStatus(delivery._id, { status: "failed", reason: reason.trim() });
        if (reschedule) {
          saved = await deliveriesApi.setStatus(delivery._id, { status: "scheduled", deliveryDate: newDate, deliveryTimeSlot: slot, today });
          toast({ title: `${delivery.deliveryId} rescheduled`, description: `Failed: ${reason.trim()}. Next try ${fmtDate(dateOnly(newDate))}.` });
        } else {
          toast({ title: `${delivery.deliveryId} marked failed`, description: reason.trim() });
        }
      } else {
        saved = await deliveriesApi.setStatus(delivery._id, { status: "scheduled", deliveryDate: newDate, deliveryTimeSlot: slot, note: note.trim() || undefined, today });
        toast({ title: `${delivery.deliveryId} rescheduled`, description: `${fmtDate(dateOnly(newDate))}, ${slotLabel(slot).toLowerCase()}` });
      }
      onDone(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      // A failed delivery that couldn't be rescheduled is still recorded as failed.
      if (mode === "fail") deliveriesApi.get(delivery._id).then(onDone).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const showDate = mode === "reschedule" || (mode === "fail" && reschedule);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{TITLE[mode]}</DialogTitle>
            <DialogDescription>
              {delivery.deliveryId} · {delivery.customerName} · {fmtDate(dateOnly(delivery.deliveryDate))}
            </DialogDescription>
          </DialogHeader>

          {mode === "dispatch" && (
            <div className="grid gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="st-driver">Driver</Label>
                <Input id="st-driver" value={driver.name} onChange={(e) => setDriver({ ...driver, name: e.target.value })} autoFocus autoComplete="off" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="st-driver-phone">Phone</Label>
                  <Input id="st-driver-phone" type="tel" inputMode="tel" value={driver.phone} onChange={(e) => setDriver({ ...driver, phone: e.target.value })} placeholder="Optional" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="st-vehicle">Vehicle no.</Label>
                  <Input id="st-vehicle" value={driver.vehicleNumber} onChange={(e) => setDriver({ ...driver, vehicleNumber: e.target.value.toUpperCase() })} placeholder="Optional" />
                </div>
              </div>
            </div>
          )}

          {mode === "deliver" && (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="st-received">Received by</Label>
                  <Input id="st-received" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} autoFocus autoComplete="off" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="st-at">Delivered at</Label>
                  <Input id="st-at" type="datetime-local" value={deliveredAt} max={nowLocal()} onChange={(e) => setDeliveredAt(e.target.value)} />
                </div>
              </div>
            </div>
          )}

          {mode === "fail" && (
            <div className="grid gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="st-reason">Why did it fail?</Label>
                <div className="flex flex-wrap gap-1.5">
                  {FAIL_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setReason(r)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-muted",
                        reason === r && "border-primary/50 bg-primary-soft/50 text-primary-strong"
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <Input id="st-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or type the reason" autoComplete="off" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={reschedule} onCheckedChange={(v) => setReschedule(v === true)} />
                Reschedule to a new date now
              </label>
            </div>
          )}

          {showDate && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="st-date">New date</Label>
                <Input id="st-date" type="date" min={localToday()} value={newDate} onChange={(e) => setNewDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="st-slot">Time slot</Label>
                <Select value={slot} onValueChange={(v) => setSlot(v as TimeSlot)}>
                  <SelectTrigger id="st-slot">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_SLOTS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(mode === "fail" || delivery.status === "failed") && <p className="col-span-2 text-xs text-muted-foreground">The next try is attempt {(delivery.attempts || 0) + 2}.</p>}
            </div>
          )}

          {mode !== "fail" && (
            <div className="space-y-1.5">
              <Label htmlFor="st-note">Note</Label>
              <Textarea id="st-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
            </div>
          )}

          {error && <p className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive-strong">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} variant={mode === "fail" ? "destructive" : "default"}>
              {busy && <Loader2 className="animate-spin" />}
              {mode === "fail" && reschedule ? "Mark failed and reschedule" : TITLE[mode]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
