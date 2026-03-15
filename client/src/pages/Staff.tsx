import { useState, useEffect } from "react";
import { Plus, Search, Users, Clock, CheckCircle, AlertCircle, Calendar, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CreateTaskDialog } from "@/components/staff/CreateTaskDialog";
import { EditTaskDialog } from "@/components/staff/EditTaskDialog";
import { CommentDialog } from "@/components/staff/CommentDialog";
import { StaffCard } from "@/components/staff/StaffCard";
import { TaskCard } from "@/components/staff/TaskCard";
import { ScheduleDialog } from "@/components/staff/ScheduleDialog";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";

export default function Staff() {
  const [staff, setStaff] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
  const [showEditTaskDialog, setShowEditTaskDialog] = useState(false);
  const [showCommentDialog, setShowCommentDialog] = useState(false);
  const [selectedTask, setSelectedTask] = useState<any>(null);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState<any>(null);
  const { toast } = useToast();

  useEffect(() => {
    fetchStaff();
    fetchTasks();
  }, []);

  const fetchStaff = async () => {
    try {
      // Use users endpoint with role filter to get staff users
      const response: any = await apiClient.get('/users', { role: 'staff' });
      console.log('👥 Staff response:', response);
      
      // Handle the actual response structure from API
      let staffData: any[] = [];
      if (response && response.users && Array.isArray(response.users)) {
        staffData = response.users;
        console.log('👥 Extracted staff from response.users:', staffData);
      } else if (response && response.data && Array.isArray(response.data.users)) {
        staffData = response.data.users;
        console.log('👥 Extracted staff from response.data.users:', staffData);
      } else if (Array.isArray(response)) {
        staffData = response;
        console.log('👥 Using direct response array:', staffData);
      } else if (response && Array.isArray(response.data)) {
        staffData = response.data;
        console.log('👥 Using response.data array:', staffData);
      } else {
        console.log('👥 Unexpected response structure:', response);
      }
      
      console.log('👥 Final staff data:', staffData);
      console.log('👥 Staff count:', staffData.length);
      
      // Ensure it's an array before setting state
      setStaff(Array.isArray(staffData) ? staffData : []);
    } catch (error) {
      console.error('Error fetching staff:', error);
      toast({
        title: "Error",
        description: "Failed to fetch staff",
        variant: "destructive",
      });
    }
  };

  const fetchTasks = async () => {
    try {
      const response: any = await apiClient.getTasks();
      console.log('📋 Tasks response:', response);
      
      // Handle the actual response structure from API
      let tasksData = [];
      if (response && response.data && Array.isArray(response.data)) {
        tasksData = response.data;
        console.log('📋 Extracted tasks from response.data:', tasksData);
      } else if (Array.isArray(response)) {
        tasksData = response;
        console.log('📋 Using direct response array:', tasksData);
      } else {
        console.log('📋 Unexpected response structure:', response);
      }
      
      console.log('📋 Processed tasks:', tasksData);
      console.log('📋 Tasks count:', tasksData.length);
      setTasks(tasksData);
    } catch (error) {
      console.error('Error fetching tasks:', error);
      toast({
        title: "Error",
        description: "Failed to fetch tasks",
        variant: "destructive",
      });
    }
  };

  const filteredStaff = staff.filter(member => {
    try {
      const name = member?.fullName || member?.name || '';
      const position = member?.role || '';
      const searchTermLower = searchTerm.toLowerCase();
      
      // Only require name to be present for filtering
      if (!name) return false;
      
      // Filter by name or position if search term exists
      if (searchTermLower) {
        return (typeof name === 'string' && name.toLowerCase().includes(searchTermLower)) ||
               (typeof position === 'string' && position.toLowerCase().includes(searchTermLower));
      }
      
      return true; // Show all staff if no search term
    } catch (error) {
      console.error('Error filtering staff member:', error, member);
      return false;
    }
  });

  const filteredTasks = tasks.filter(task => {
    try {
      const title = task?.title || '';
      const assignedStaff = task?.assignedTo;
      let staffName = '';
      
      // Extract staff name from assignedTo field
      if (assignedStaff) {
        if (typeof assignedStaff === 'string') {
          staffName = assignedStaff; // If it's just an ID, we'll show the ID
        } else if (assignedStaff?.fullName) {
          staffName = assignedStaff.fullName;
        } else if (assignedStaff?.name) {
          staffName = assignedStaff.name;
        }
      }
      
      const jobTitle = task?.jobId?.title || '';
      const searchTermLower = searchTerm.toLowerCase();
      
      return title.toLowerCase().includes(searchTermLower) ||
             staffName.toLowerCase().includes(searchTermLower) ||
             jobTitle.toLowerCase().includes(searchTermLower);
    } catch (error) {
      console.error('Error filtering task:', error, task);
      return false;
    }
  });

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(task => task.status === "completed").length;
  const overdueTasks = tasks.filter(task => {
    if (!task.due_date || task.status === "completed") return false;
    const dueDate = new Date(task.due_date);
    const now = new Date();
    return dueDate < now;
  }).length;
  const activeStaff = staff.filter(member => {
    try {
      return member?.isActive === true;
    } catch (error) {
      console.error('Error calculating active staff:', error, member);
      return false;
    }
  }).length;

  const handleScheduleClick = (staffMember: any) => {
    const formattedStaff = {
      id: staffMember._id || staffMember.id,
      name: staffMember.fullName || staffMember.name || 'Unknown Staff',
      role: staffMember.role || 'Staff',
      department: staffMember.department || 'General'
    };
    setSelectedStaff(formattedStaff);
    setShowScheduleDialog(true);
  };

  const handleEditTask = (task: any) => {
    console.log('🔧 Editing task:', task);
    setSelectedTask(task);
    setShowEditTaskDialog(true);
  };

  const handleComment = (task: any) => {
    console.log('💬 Adding comment to task:', task);
    setSelectedTask(task);
    setShowCommentDialog(true);
  };

  const handleComplete = async (task: any) => {
    console.log('✅ Completing task:', task);
    try {
      await apiClient.updateTaskStatus(task._id || task.id, 'completed');
      toast({
        title: "Task Completed",
        description: "Task has been marked as completed",
      });
      fetchTasks(); // Refresh tasks to show updated status
    } catch (error: any) {
      console.error('Error completing task:', error);
      toast({
        title: "Error",
        description: error.response?.data?.message || "Failed to complete task",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Staff & Task Management</h1>
          <p className="text-muted-foreground">Manage team members and assign tasks</p>
        </div>
        <div className="flex space-x-2">
          <Button onClick={() => setShowCreateTaskDialog(true)} variant="gradient" size="lg" className="gap-2">
            <Plus className="h-4 w-4" />
            Create Task
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4" />
              Active Staff
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeStaff}</div>
            <p className="text-xs text-muted-foreground">team members</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Total Tasks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalTasks}</div>
            <p className="text-xs text-muted-foreground">all time</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-success" />
              Completed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-success">{completedTasks}</div>
            <p className="text-xs text-muted-foreground">tasks finished</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-destructive" />
              Overdue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{overdueTasks}</div>
            <p className="text-xs text-muted-foreground">need attention</p>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search staff or tasks..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Tabs */}
      <Tabs defaultValue="staff" className="space-y-6">
        <TabsList>
          <TabsTrigger value="staff">Staff</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
        </TabsList>
        <TabsContent value="staff" className="space-y-4">
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {filteredStaff.map((member) => (
              <StaffCard 
                key={member._id || member.id}  
                staff={{
                  id: member._id || member.id,
                  name: member.fullName || member.name || 'Unknown Staff',
                  role: member.role || 'Staff',
                  department: member.department || 'General',
                  email: member.email || 'Not provided',
                  phone: member.phone || '',
                  fullName: member.fullName,
                  isActive: member.isActive,
                  companyName: member.companyName,
                  dataScope: member.dataScope,
                  permissions: member.permissions,
                  avatar: member.avatar,
                  lastLogin: member.lastLogin,
                  createdAt: member.createdAt,
                  updatedAt: member.updatedAt,
                  activeTasks: tasks.filter(task => {
                    const assignedTo = task.assignedTo;
                    if (typeof assignedTo === 'string') {
                      return assignedTo === (member._id || member.id) && task.status !== 'completed';
                    } else if (assignedTo?._id) {
                      return assignedTo._id === (member._id || member.id) && task.status !== 'completed';
                    }
                    return false;
                  }).length,
                  completedTasks: tasks.filter(task => {
                    const assignedTo = task.assignedTo;
                    if (typeof assignedTo === 'string') {
                      return assignedTo === (member._id || member.id) && task.status === 'completed';
                    } else if (assignedTo?._id) {
                      return assignedTo._id === (member._id || member.id) && task.status === 'completed';
                    }
                    return false;
                  }).length,
                  status: member.isActive ? 'active' : 'inactive'
                }}
                onSchedule={() => handleScheduleClick(member)}
                onStaffUpdated={fetchStaff}
              />
            ))}
          </div>
          {filteredStaff.length === 0 && (
            <div className="text-center py-12">
              <User className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No staff found</h3>
              <p className="text-muted-foreground">No staff members match your search criteria.</p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="tasks" className="space-y-4">
          {filteredTasks.map((task) => (
            <TaskCard key={task._id || task.id} task={task} onEdit={handleEditTask} onComment={handleComment} onComplete={handleComplete} />
          ))}
          {filteredTasks.length === 0 && (
            <div className="text-center py-12">
              <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No tasks found</h3>
              <p className="text-muted-foreground">No tasks match your search criteria.</p>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <CreateTaskDialog
        open={showCreateTaskDialog}
        onOpenChange={setShowCreateTaskDialog}
        onTaskCreated={fetchTasks}
      />

      <EditTaskDialog
        open={showEditTaskDialog}
        onOpenChange={setShowEditTaskDialog}
        task={selectedTask}
        onTaskUpdated={fetchTasks}
      />

      <CommentDialog
        open={showCommentDialog}
        onOpenChange={setShowCommentDialog}
        task={selectedTask}
        onCommentAdded={fetchTasks}
      />

      <ScheduleDialog
        open={showScheduleDialog}
        onOpenChange={setShowScheduleDialog}
        staff={selectedStaff || {
          id: '',
          name: '',
          role: '',
          department: ''
        }}
        onScheduleSaved={() => {
          // Refresh staff data if needed
          fetchStaff();
        }}
      />
    </div>
  );
}