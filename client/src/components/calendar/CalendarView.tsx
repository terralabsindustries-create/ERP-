import { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight, Plus, Clock, AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import apiClient from "@/lib/apiClient";
import { useAuth } from "@/contexts/AuthContext";
import { format, isSameDay, isToday } from "date-fns";
import { toast } from "sonner";

interface CalendarViewProps {
  selectedDate: Date;
  onDateSelect: (date: Date) => void;
  refreshKey?: number;
}

export function CalendarView({ selectedDate, onDateSelect, refreshKey }: CalendarViewProps) {
  const { user } = useAuth();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [events, setEvents] = useState<{ 
    id: string; 
    _id?: string;
    title: string; 
    startDate: string; 
    endDate: string;
    description?: string; 
    priority?: string; 
    eventType?: string;
    status?: string;
  }[]>([]);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);

  const updateTaskStatus = async (taskId: string, newStatus: string) => {
    try {
      setUpdatingTaskId(taskId);
      await apiClient.updateTaskStatus(taskId, newStatus);
      toast.success(`Task status changed to ${newStatus}`);

      // Refresh events to show updated status
      fetchEvents();
    } catch (error: any) {
      console.error('Error updating task status:', error);

      const errorMessage = error.response?.data?.message ||
                          error.response?.data?.error || 
                          error.message || 
                          "Failed to update task status";
      
      toast.error(errorMessage);
    } finally {
      setUpdatingTaskId(null);
    }
  };

  const fetchEvents = async () => {
    if (!user || !(user as any).id) {
      return;
    }

    const staffId = (user as any).id;

    // Two task sources, because they scope differently:
    //   /tasks              -> tasks this user owns (what an admin/manager sees)
    //   /tasks/by-staff/:id -> tasks assigned to this user (what staff sees)
    // Fetching both and merging means the calendar is correct for every role.
    // Calendar events are a third, independent source; one failing must not
    // blank out the others, so they all settle separately.
    const [ownedResult, assignedResult, eventsResult] = await Promise.allSettled([
      apiClient.getTasks(),
      apiClient.get(`/tasks/by-staff/${staffId}`),
      apiClient.getEvents(),
    ]);

    const toTaskList = (result: PromiseSettledResult<any>) => {
      if (result.status !== "fulfilled") {
        console.error("Error fetching tasks:", result.reason);
        return [];
      }
      const v: any = result.value;
      const list = v?.tasks || (Array.isArray(v?.data) ? v.data : null) || (Array.isArray(v) ? v : []);
      return Array.isArray(list) ? list : [];
    };

    // Merge by id — a task you own and are assigned to must not appear twice.
    const byId = new Map<string, any>();
    [...toTaskList(ownedResult), ...toTaskList(assignedResult)].forEach((task: any) => {
      const id = task._id || task.id;
      if (id) byId.set(String(id), task);
    });

    const taskEvents = Array.from(byId.values()).map((task: any) => ({
      id: task._id || task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      eventType: "task",
      status: task.status,
      startDate: task.dueDate || task.createdAt || new Date().toISOString(),
      endDate: task.dueDate || task.createdAt || new Date().toISOString(),
    }));

    const rawEvents =
      eventsResult.status === "fulfilled"
        ? ((eventsResult.value as any)?.events || (eventsResult.value as any) || [])
        : [];

    const calendarEvents = (Array.isArray(rawEvents) ? rawEvents : []).map((ev: any) => ({
      id: ev._id || ev.id,
      _id: ev._id,
      title: ev.title,
      description: ev.description,
      priority: ev.priority,
      eventType: ev.eventType || "other",
      status: ev.status,
      startDate: ev.startDate,
      endDate: ev.endDate || ev.startDate,
    }));

    if (eventsResult.status === "rejected") {
      console.error("Error fetching calendar events:", eventsResult.reason);
      toast.error("Could not load calendar events");
    }

    setEvents([...taskEvents, ...calendarEvents]);
  };

  useEffect(() => {
    if (user) {
      fetchEvents();
    }
  }, [user, refreshKey]);

  // Auto-navigate to month with events
  useEffect(() => {
    if (events.length > 0) {
      const firstEventDate = new Date(events[0].startDate);
      const currentDate = new Date();

      // If the first event is in a different year, navigate to that year
      if (firstEventDate.getFullYear() !== currentDate.getFullYear()) {
        setCurrentMonth(new Date(firstEventDate.getFullYear(), firstEventDate.getMonth(), 1));
      }
    }
  }, [events]);

  // Helper function to get events for a specific date
  const getEventsForDate = (date: Date) => {
    return events.filter(event => {
      const eventStartDate = new Date(event.startDate);
      const eventEndDate = new Date(event.endDate);

      const isSameDayMatch = isSameDay(eventStartDate, date);
      const isInRangeMatch = date >= eventStartDate && date <= eventEndDate;

      // Check if the date falls within the event's date range
      return isSameDayMatch || isInRangeMatch;
    });
  };

  // Items for the day the user clicked, soonest first.
  const selectedEvents = getEventsForDate(selectedDate).sort(
    (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  // Helper function to get event badge variant based on priority and status
  const getEventBadgeVariant = (event: any) => {
    if (event.status === 'completed') return 'secondary';
    if (event.priority === 'urgent') return 'destructive';
    if (event.priority === 'high') return 'destructive';
    if (event.priority === 'medium') return 'default';
    return 'secondary';
  };

  // Helper function to get event icon based on type and status
  const getEventIcon = (event: any) => {
    if (event.status === 'completed') return <CheckCircle className="h-3 w-3" />;
    if (event.priority === 'urgent' || event.priority === 'high') return <AlertCircle className="h-3 w-3" />;
    return <Clock className="h-3 w-3" />;
  };

  const getPriorityBadgeVariant = (priority?: string) => {
    if (priority === 'urgent') return 'destructive';
    if (priority === 'high') return 'warning';
    if (priority === 'medium') return 'secondary';
    return 'outline';
  };

  const getStatusBadgeVariant = (status?: string) => {
    if (status === 'completed') return 'success';
    if (status === 'in_progress') return 'pending';
    if (status === 'cancelled') return 'destructive';
    return 'outline';
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>
            {currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            <span className="text-sm text-muted-foreground ml-2">
              ({events.length} tasks)
            </span>
          </CardTitle>
          <div className="flex space-x-2">
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => setCurrentMonth(new Date(currentMonth.setMonth(currentMonth.getMonth() - 1)))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => setCurrentMonth(new Date(currentMonth.setMonth(currentMonth.getMonth() + 1)))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => setCurrentMonth(new Date())}
            >
              Today
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-7 gap-2 mb-4">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
            <div key={day} className="p-2 text-center font-medium text-sm text-muted-foreground">
              {day}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: 35 }, (_, i) => {
            const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), i - 6);
            const isCurrentMonth = date.getMonth() === currentMonth.getMonth();
            const isTodayDate = isToday(date);
            const isSelected = isSameDay(date, selectedDate);
            const dayEvents = getEventsForDate(date);
            
            return (
              <TooltipProvider key={i}>
                <div
                  className={`p-2 min-h-[100px] border rounded cursor-pointer hover:bg-muted/50 transition-colors ${
                    isCurrentMonth ? 'bg-background' : 'bg-muted/20'
                  } ${isTodayDate ? 'border-primary bg-primary/5' : 'border-border'} ${
                    isSelected ? 'ring-2 ring-primary' : ''
                  }`}
                  onClick={() => onDateSelect(date)}
                >
                  <div className={`text-sm font-medium mb-1 ${
                    isCurrentMonth ? 'text-foreground' : 'text-muted-foreground'
                  } ${isTodayDate ? 'text-primary' : ''}`}>
                    {date.getDate()}
                  </div>
                  
                  {/* Events for this date */}
                  <div className="space-y-1">
                    {dayEvents.slice(0, 3).map((event) => (
                      <Tooltip key={event.id}>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-1">
                            {getEventIcon(event)}
                            <Badge 
                              variant={getEventBadgeVariant(event)}
                              className="text-xs px-1 py-0 flex-1 truncate"
                            >
                              {event.title.length > 12 ? `${event.title.substring(0, 12)}...` : event.title}
                            </Badge>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="space-y-2">
                            <p className="font-medium">{event.title}</p>
                            {event.description && <p className="text-sm text-muted-foreground">{event.description}</p>}
                            <div className="flex items-center gap-2">
                              <Badge variant={getPriorityBadgeVariant(event.priority)} className="text-xs">
                                {event.priority}
                              </Badge>
                              <Badge variant={getStatusBadgeVariant(event.status)} className="text-xs">
                                {event.status}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Due: {format(new Date(event.startDate), 'MMM dd, h:mm a')}
                            </p>
                            {event.eventType === 'task' && event.status !== 'completed' && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="w-full text-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateTaskStatus(event._id || event.id, 'completed');
                                }}
                                disabled={updatingTaskId === (event._id || event.id)}
                              >
                                {updatingTaskId === (event._id || event.id) ? 'Updating...' : 'Mark Complete'}
                              </Button>
                            )}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                    
                    {/* Show "more" indicator if there are more than 3 events */}
                    {dayEvents.length > 3 && (
                      <div className="text-xs text-muted-foreground text-center">
                        +{dayEvents.length - 3} more
                      </div>
                    )}
                  </div>
                </div>
              </TooltipProvider>
            );
          })}
        </div>
        
        {/* Events for the day the user clicked (defaults to today) */}
        <div className="mt-6 space-y-4">
          <div className="border-t pt-4">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-lg font-semibold">
                {isToday(selectedDate)
                  ? "Today's Tasks"
                  : `Tasks on ${format(selectedDate, 'EEEE, MMM d')}`}
              </h3>
              {selectedEvents.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {selectedEvents.length} {selectedEvents.length === 1 ? 'item' : 'items'}
                </span>
              )}
            </div>
            {selectedEvents.length > 0 ? (
              <div className="space-y-2">
                {selectedEvents.map((event) => (
                  <div key={event.id} className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg">
                    {getEventIcon(event)}
                    <div className="flex-1">
                      <p className="font-medium">{event.title}</p>
                      {event.description && <p className="text-sm text-muted-foreground">{event.description}</p>}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Due: {format(new Date(event.startDate), 'MMM dd, h:mm a')}</span>
                        {event.status === 'completed' && <span className="text-success">✓ Completed</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={getEventBadgeVariant(event)} className="text-xs">
                        {event.priority}
                      </Badge>
                      {event.eventType === 'task' && event.status !== 'completed' ? (
                        <Select
                          value={event.status}
                          onValueChange={(value) => updateTaskStatus(event._id || event.id, value)}
                          disabled={updatingTaskId === (event._id || event.id)}
                        >
                          <SelectTrigger className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="in_progress">In Progress</SelectItem>
                            <SelectItem value="completed">Completed</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline" className="text-xs">
                          {event.status}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                {isToday(selectedDate)
                  ? 'No tasks due today'
                  : `Nothing scheduled for ${format(selectedDate, 'MMM d, yyyy')}`}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
