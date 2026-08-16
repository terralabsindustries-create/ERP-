import { useState } from "react";
import { CalendarView } from "@/components/calendar/CalendarView";
import { ReminderPanel } from "@/components/calendar/ReminderPanel";
import { CreateEventDialog } from "@/components/calendar/CreateEventDialog";

export default function CalendarPage() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [refreshKey, setRefreshKey] = useState(0);

  // Bumping this re-runs the fetches in both panels.
  const refresh = () => setRefreshKey((k) => k + 1);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Calendar &amp; Reminders</h1>
          <p className="text-muted-foreground text-sm">Centralized view of tasks, deliveries, and deadlines</p>
        </div>
        <CreateEventDialog selectedDate={selectedDate} onEventCreated={refresh} />
      </div>

      <div className="grid gap-6 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <CalendarView 
            selectedDate={selectedDate} 
            onDateSelect={setSelectedDate}
            refreshKey={refreshKey}
          />
        </div>
        <div className="lg:col-span-1">
          <ReminderPanel refreshKey={refreshKey} />
        </div>
      </div>
    </div>
  );
}