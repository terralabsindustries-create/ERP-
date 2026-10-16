import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EditorSheet } from "@/components/users/EditorSheet";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { KIND_META, type CalKind, type RawEvent } from "@/lib/calendarItems";
import { cn } from "@/lib/utils";

interface CreateEventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The day to start a new event on. */
  defaultDate?: Date;
  /** Pass an event to edit it instead of creating one. */
  event?: RawEvent | null;
  onEventCreated?: () => void;
}

const DURATIONS = [
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "240", label: "Half a day" }
];
const KINDS: CalKind[] = ["reminder", "meeting", "deadline", "delivery", "other"];

const blank = (day?: Date) => ({
  title: "",
  description: "",
  date: format(day || new Date(), "yyyy-MM-dd"),
  time: "10:00",
  duration: "60",
  allDay: false,
  eventType: "reminder" as string,
  priority: "medium",
  location: ""
});

/** Adds or edits a calendar event: what, when, how long and what kind. */
export function CreateEventDialog({ open, onOpenChange, defaultDate, event, onEventCreated }: CreateEventDialogProps) {
  const { toast } = useToast();
  const [form, setForm] = useState(blank(defaultDate));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (event) {
      const start = new Date(event.startDate);
      const end = event.endDate ? new Date(event.endDate) : start;
      const minutes = Math.max(15, Math.round((end.getTime() - start.getTime()) / 60000));
      setForm({
        title: event.title,
        description: event.description || "",
        date: format(start, "yyyy-MM-dd"),
        time: format(start, "HH:mm"),
        duration: DURATIONS.some((d) => d.value === String(minutes)) ? String(minutes) : "60",
        allDay: !!event.allDay,
        eventType: event.eventType || "other",
        priority: event.priority || "medium",
        location: event.location || ""
      });
    } else setForm(blank(defaultDate));
  }, [open, event, defaultDate]);

  const set = <K extends keyof ReturnType<typeof blank>>(k: K, v: ReturnType<typeof blank>[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.date) {
      toast({ title: "Add a title and a date", variant: "destructive" });
      return;
    }
    const start = form.allDay ? new Date(`${form.date}T00:00`) : new Date(`${form.date}T${form.time || "00:00"}`);
    const end = form.allDay ? new Date(`${form.date}T23:59`) : new Date(start.getTime() + Number(form.duration) * 60000);
    const payload = {
      title: form.title.trim(),
      description: form.description,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      allDay: form.allDay,
      eventType: form.eventType,
      priority: form.priority,
      location: form.location || undefined,
      ...(event ? {} : { status: "scheduled" })
    };
    setSaving(true);
    try {
      if (event) await apiClient.updateEvent(event._id, payload);
      else await apiClient.createEvent(payload);
      toast({ title: event ? "Event updated" : "Added to the calendar", description: `${payload.title} · ${format(start, form.allDay ? "d MMM" : "d MMM, h:mm a")}` });
      onOpenChange(false);
      onEventCreated?.();
    } catch (error) {
      toast({ title: event ? "Not updated" : "Not added", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      title={event ? "Edit event" : "New event"}
      description="Reminders, meetings, deadlines and deliveries show on everyone's calendar in your business."
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {event ? "Save changes" : "Add event"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ev-title">Title</Label>
          <Input id="ev-title" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Collect proofs from Sharma Traders" autoFocus />
        </div>

        <div className="space-y-1.5">
          <Label>Kind</Label>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={form.eventType === k}
                onClick={() => set("eventType", k)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] transition-colors",
                  form.eventType === k ? "border-primary bg-primary-soft/50 font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <span className={cn("h-2 w-2 rounded-full", KIND_META[k].dot)} aria-hidden />
                {KIND_META[k].label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="ev-date">Date</Label>
            <Input id="ev-date" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
          </div>
          <div className="flex items-end gap-2 pb-2">
            <Switch id="ev-allday" checked={form.allDay} onCheckedChange={(v) => set("allDay", v)} />
            <Label htmlFor="ev-allday" className="font-normal">
              All day
            </Label>
          </div>
        </div>

        {!form.allDay && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ev-time">Starts at</Label>
              <Input id="ev-time" type="time" value={form.time} onChange={(e) => set("time", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-duration">Lasts</Label>
              <Select value={form.duration} onValueChange={(v) => set("duration", v)}>
                <SelectTrigger id="ev-duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ev-priority">Priority</Label>
            <Select value={form.priority} onValueChange={(v) => set("priority", v)}>
              <SelectTrigger id="ev-priority">
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
          <div className="space-y-1.5">
            <Label htmlFor="ev-location">Where</Label>
            <Input id="ev-location" value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Optional" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-notes">Notes</Label>
          <Textarea id="ev-notes" rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="Optional" />
        </div>
      </div>
    </EditorSheet>
  );
}
