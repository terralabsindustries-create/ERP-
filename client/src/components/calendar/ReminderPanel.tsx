import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { format, isToday } from "date-fns";
import {
  Bell,
  Calendar,
  Clock,
  AlertTriangle,
  CheckCircle,
  Plus,
  Package,
  CreditCard,
  FileText,
  Users,
  BarChart3,
  Settings
} from "lucide-react";
import apiClient from "@/lib/apiClient";

interface Event {
  id: string;
  title: string;
  description?: string; 
  priority?: string; 
  eventType?: string;
  status?: string;
  startDate: string;
  endDate: string;
}

export function ReminderPanel({ refreshKey }: { refreshKey: number }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [events, setEvents] = useState<Event[]>([]);

  const fetchReminders = async () => {
    if (!user || !(user as any).id) {
      return;
    }

    try {
      const staffId = (user as any).id;

      // Tasks come from two differently-scoped endpoints: /tasks returns what
      // this user owns (admin/manager view), /tasks/by-staff returns what is
      // assigned to them (staff view). Merge both so every role sees its work.
      const [ownedRes, assignedRes] = await Promise.allSettled([
        apiClient.getTasks(),
        apiClient.get(`/tasks/by-staff/${staffId}`),
      ]);

      const toList = (r: PromiseSettledResult<any>) => {
        if (r.status !== 'fulfilled') {
          console.error('📋 Error fetching tasks:', r.reason);
          return [];
        }
        const v: any = r.value;
        const list = v?.tasks || (Array.isArray(v?.data) ? v.data : null) || (Array.isArray(v) ? v : []);
        return Array.isArray(list) ? list : [];
      };

      const taskMap = new Map<string, any>();
      [...toList(ownedRes), ...toList(assignedRes)].forEach((t: any) => {
        const id = t._id || t.id;
        if (id) taskMap.set(String(id), t);
      });
      const tasksData = Array.from(taskMap.values());
      
      // Fetch staff's schedule for today
      const scheduleResponse: any = await apiClient.getStaffSchedule(staffId);
      let todaySchedule = null;

      // Handle different response structures for schedule
      const today = new Date().getDay(); // 0 = Sunday, 1 = Monday, etc.
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const todayName = dayNames[today];
      if (Array.isArray(scheduleResponse)) {
        todaySchedule = scheduleResponse.find((s: any) => s.dayOfWeek === todayName);
      } else if (scheduleResponse?.data && Array.isArray(scheduleResponse.data)) {
        todaySchedule = scheduleResponse.data.find((s: any) => s.dayOfWeek === todayName);
      }

      // Convert tasks to event format
      const taskEvents = tasksData.map((task: any) => {
        return {
          id: task._id || task.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          eventType: 'task',
          status: task.status,
          startDate: task.dueDate || task.createdAt || new Date().toISOString(),
          endDate: task.dueDate || task.createdAt || new Date().toISOString()
        };
      });
      
      // Convert schedule to event format
      let scheduleEvents = [];
      if (todaySchedule) {
        scheduleEvents = [{
          id: `schedule-${todaySchedule._id}`,
          title: `${todaySchedule.shiftType} Shift`,
          description: `Working hours: ${todaySchedule.startTime} - ${todaySchedule.endTime}`,
          priority: 'medium',
          eventType: 'schedule',
          status: 'scheduled',
          startDate: new Date().toISOString(),
          endDate: new Date().toISOString()
        }];
      }
      
      // Calendar events (reminders, meetings, deadlines) created on this page.
      // Fetched separately so a failure here still leaves tasks and schedule.
      let calendarEvents: any[] = [];
      try {
        const eventsResponse: any = await apiClient.getEvents();
        const raw = eventsResponse?.events || eventsResponse || [];
        calendarEvents = (Array.isArray(raw) ? raw : [])
          .filter((ev: any) => ev.status !== 'completed' && ev.status !== 'cancelled')
          .map((ev: any) => ({
            id: ev._id || ev.id,
            title: ev.title,
            description: ev.description,
            priority: ev.priority || 'medium',
            eventType: ev.eventType || 'reminder',
            status: ev.status,
            startDate: ev.startDate,
            endDate: ev.endDate || ev.startDate,
          }));
      } catch (err) {
        console.error('🔔 Error fetching calendar events:', err);
      }

      const allEvents = [...taskEvents, ...calendarEvents, ...scheduleEvents]
        // Soonest first, so what needs attention is at the top.
        .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

      // If no events were found, create a default schedule event for today
      if (allEvents.length === 0) {
        const defaultEvent = {
          id: 'default-schedule',
          title: 'Today\'s Schedule',
          description: 'Check your tasks and schedule in the dashboard',
          priority: 'medium',
          eventType: 'schedule',
          status: 'scheduled',
          startDate: new Date().toISOString(),
          endDate: new Date().toISOString()
        };
        setEvents([defaultEvent]);
      } else {
        setEvents(allEvents);
      }
    } catch (error) {
      console.error("Error fetching reminders:", error);
      toast.error("Failed to load reminders");
    }
  };

  const markAsCompleted = async (eventId: string, eventType?: string) => {
    try {
      // Check if this is a task (starts with task ID format) or schedule
      if (eventId.startsWith('schedule-') || eventId === 'default-schedule') {
        // Schedules can't be marked as completed
        toast.info("Schedule cannot be marked as completed");
        return;
      }

      // Tasks and calendar events live in different collections and have
      // different status endpoints, so dispatch on where the row came from.
      if (eventType === 'task') {
        await apiClient.updateTaskStatus(eventId, 'completed');
        toast.success("Task completed");
      } else {
        await apiClient.updateEventStatus(eventId, 'completed');
        toast.success("Event completed");
      }

      fetchReminders();
    } catch (error: any) {
      console.error("🔔 Error marking task as completed:", error);
      console.error("🔔 Error response:", error.response);
      
      const errorMessage = error.response?.data?.message || 
                          error.response?.data?.error || 
                          error.message || 
                          "Failed to update task";
      
      toast.error(errorMessage);
    }
  };

  useEffect(() => {
    if (user) {
      fetchReminders();
    }
  }, [user, refreshKey]);

  const getIcon = (eventType: string) => {
    switch (eventType) {
      case "task": return Clock;
      case "schedule": return Calendar;
      case "deadline": return AlertTriangle;
      case "meeting": return Calendar;
      case "delivery": return AlertTriangle;
      case "reminder": return Clock;
      default: return Clock;
    }
  };

  const getVariant = (priority: string, status: string) => {
    if (status === 'completed') return "secondary";
    if (priority === "urgent" || priority === "high") return "destructive";
    if (priority === "medium") return "default";
    return "secondary";
  };

  // Filter events for today only: schedule events always show, and all
  // assigned tasks show regardless of due date (matches the staff dashboard).
  const todayEvents = events.filter(event => (
    event.eventType === 'schedule' || event.eventType === 'task'
  ));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Today's Reminders</CardTitle>
            <Badge variant="secondary" className="text-xs">
              {todayEvents.length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {todayEvents.length === 0 ? (
            <div className="text-center py-6">
              <Bell className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No events scheduled for today
              </p>
            </div>
          ) : (
            todayEvents.map((event) => {
              const Icon = getIcon(event.eventType || 'other');
              const eventTime = new Date(event.startDate);
              const isOverdue = eventTime < new Date() && event.status !== 'completed';
              
              return (
                <div key={event.id} className={`flex items-center justify-between p-3 border rounded-lg transition-colors ${
                  isOverdue ? 'border-destructive/30 bg-destructive/5' : 'hover:bg-muted/30'
                }`}>
                  <div className="flex items-center space-x-3">
                    <Icon className={`h-4 w-4 ${
                      event.priority === 'urgent' || event.priority === 'high' ? 'text-destructive' :
                      event.priority === 'medium' ? 'text-primary' : 'text-muted-foreground'
                    }`} />
                    <div>
                      <p className="text-sm font-medium">{event.title}</p>
                      {event.description && (
                        <p className="text-xs text-muted-foreground line-clamp-1">{event.description}</p>
                      )}
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-muted-foreground">
                          {event.eventType === 'schedule' 
                            ? event.description?.split(':')[1]?.trim() || 'All day'
                            : format(eventTime, 'h:mm a')
                          }
                        </p>
                        {isOverdue && event.eventType === 'task' && (
                          <Badge variant="destructive" className="text-xs">
                            Overdue
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center space-x-2">
                    <Badge variant={getVariant(event.priority || 'medium', event.status || 'scheduled') as any} className="text-xs">
                      {event.priority || 'medium'}
                    </Badge>
                    {event.eventType === 'task' && event.status !== 'completed' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => markAsCompleted(event.id, event.eventType)}
                        className="h-6 w-6 p-0 hover:bg-success/10"
                        title="Mark as completed"
                      >
                        <CheckCircle className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {/* Primary Actions */}
          <div className="space-y-2">
            <Button 
              variant="outline" 
              size="sm" 
              className="w-full justify-start gap-2"
              onClick={() => navigate('/jobs')}
            >
              <CheckCircle className="h-4 w-4" />
              View All Jobs
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              className="w-full justify-start gap-2"
              onClick={() => navigate('/delivery')}
            >
              <Package className="h-4 w-4" />
              Track Deliveries
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              className="w-full justify-start gap-2"
              onClick={() => navigate('/payments')}
            >
              <CreditCard className="h-4 w-4" />
              Check Payments
            </Button>
          </div>
          
          {/* Secondary Actions */}
          <div className="border-t pt-2 mt-2">
            <p className="text-xs text-muted-foreground mb-2">Quick Create</p>
            <div className="grid grid-cols-2 gap-1">
              <Button 
                variant="ghost" 
                size="sm" 
                className="text-xs justify-start gap-1"
                onClick={() => navigate('/jobs?action=create')}
              >
                <Plus className="h-3 w-3" />
                New Job
              </Button>
              <Button 
                variant="ghost" 
                size="sm" 
                className="text-xs justify-start gap-1"
                onClick={() => navigate('/customers?action=create')}
              >
                <Users className="h-3 w-3" />
                New Customer
              </Button>
              <Button 
                variant="ghost" 
                size="sm" 
                className="text-xs justify-start gap-1"
                onClick={() => navigate('/invoices?action=create')}
              >
                <FileText className="h-3 w-3" />
                New Invoice
              </Button>
              <Button 
                variant="ghost" 
                size="sm" 
                className="text-xs justify-start gap-1"
                onClick={() => navigate('/calendar?action=create')}
              >
                <Calendar className="h-3 w-3" />
                New Event
              </Button>
            </div>
          </div>
          
          {/* System Actions */}
          <div className="border-t pt-2 mt-2">
            <p className="text-xs text-muted-foreground mb-2">System</p>
            <div className="grid grid-cols-2 gap-1">
              <Button 
                variant="ghost" 
                size="sm" 
                className="text-xs justify-start gap-1"
                onClick={() => navigate('/reports')}
              >
                <BarChart3 className="h-3 w-3" />
                Reports
              </Button>
              <Button 
                variant="ghost" 
                size="sm" 
                className="text-xs justify-start gap-1"
                onClick={() => navigate('/settings')}
              >
                <Settings className="h-3 w-3" />
                Settings
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
