import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Clock, User, AlertTriangle, CheckCircle, Edit, MessageSquare } from "lucide-react";

interface TaskCardProps {
  task: {
    id: string;
    title: string;
    jobId: string | { _id: string; title: string; status: string };
    assignedTo: string | { _id: string; fullName: string; email: string; role: string; department: string };
    priority: string;
    status: string;
    dueDate: string;
    description: string;
    attachments: any[];
    comments?: any[];
  };
  onEdit?: (task: any) => void;
  onComment?: (task: any) => void;
  onComplete?: (task: any) => void;
}

export function TaskCard({ task, onComment, onComplete, onEdit }: TaskCardProps) {
  // Helper functions to safely extract values from objects
  const getJobInfo = () => {
    if (typeof task.jobId === 'string') {
      return { id: task.jobId, title: 'Unknown Job' };
    }
    return {
      id: task.jobId?._id || task.jobId?.id || 'Unknown',
      title: task.jobId?.title || 'Unknown Job'
    };
  };

  const getAssignedStaffInfo = () => {
    if (typeof task.assignedTo === 'string') {
      return { name: task.assignedTo, position: 'Staff' };
    }
    return {
      name: task.assignedTo?.fullName || 'Unassigned',
      position: task.assignedTo?.role || 'Staff'
    };
  };

  const getPriorityVariant = (priority: string) => {
    switch (priority) {
      case "urgent": return "destructive";
      case "high": return "warning";
      case "medium": return "secondary";
      case "low": return "outline";
      default: return "secondary";
    }
  };

  const getStatusVariant = (status: string) => {
    switch (status) {
      case "completed": return "success";
      case "in-progress": return "secondary";
      case "pending": return "outline";
      case "overdue": return "destructive";
      default: return "secondary";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed": return <CheckCircle className="h-3 w-3" />;
      case "overdue": return <AlertTriangle className="h-3 w-3" />;
      default: return <Clock className="h-3 w-3" />;
    }
  };

  const isOverdue = () => {
    if (!task.dueDate || task.dueDate === 'No due date' || task.dueDate === 'Invalid date') {
      return false;
    }
    const dueDate = new Date(task.dueDate);
    if (isNaN(dueDate.getTime())) {
      return false;
    }
    return dueDate < new Date() && task.status !== "completed";
  };

  const formatDueDate = () => {
    if (!task.dueDate || task.dueDate === 'No due date' || task.dueDate === 'Invalid date') {
      return 'No due date';
    }
    const dueDate = new Date(task.dueDate);
    if (isNaN(dueDate.getTime())) {
      return 'Invalid date';
    }
    return dueDate.toLocaleDateString();
  };

  const getDaysUntilDue = () => {
    if (!task.dueDate || task.dueDate === 'No due date' || task.dueDate === 'Invalid date') {
      return null;
    }
    const dueDate = new Date(task.dueDate);
    if (isNaN(dueDate.getTime())) {
      return null;
    }
    return Math.ceil((dueDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
  };

  return (
    <tr className={`border-b hover:bg-muted/30 transition-colors ${isOverdue() ? "bg-destructive/5" : ""}`}>
      <td className="px-4 py-3">
        <div className="font-medium">{task.title}</div>
        <div className="text-xs text-muted-foreground">Job: {getJobInfo().title}</div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1 text-muted-foreground">
          <User className="h-3 w-3" />
          {getAssignedStaffInfo().name}
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={getPriorityVariant(task.priority)}>{task.priority}</Badge>
      </td>
      <td className="px-4 py-3">
        <Badge variant={getStatusVariant(task.status)} className="gap-1">
          {getStatusIcon(task.status)}
          {task.status}
        </Badge>
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        <div>{formatDueDate()}</div>
        <div className={`text-xs ${isOverdue() ? "text-destructive" : ""}`}>
          {isOverdue() ? "Overdue" : task.status === "completed" ? "" : (() => {
            const days = getDaysUntilDue();
            return days !== null ? `Due in ${days} days` : '';
          })()}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-8 gap-1 px-2" onClick={() => onComment?.(task)}>
            <MessageSquare className="h-4 w-4" />
            {task.comments && task.comments.length > 0 && (
              <span className="text-xs">{task.comments.length}</span>
            )}
          </Button>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => onEdit?.(task)}>
            <Edit className="h-4 w-4" />
          </Button>
          {task.status !== "completed" && (
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => onComplete?.(task)}>
              <CheckCircle className="h-4 w-4" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}