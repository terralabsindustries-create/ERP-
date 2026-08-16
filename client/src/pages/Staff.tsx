import { useState, useEffect } from "react";
import { Plus, Search, Users, Clock, CheckCircle, AlertCircle, User, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
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
  const [managers, setManagers] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
  const [showEditTaskDialog, setShowEditTaskDialog] = useState(false);
  const [showCommentDialog, setShowCommentDialog] = useState(false);
  const [selectedTask, setSelectedTask] = useState<any>(null);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState<any>(null);
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; user: any; type: string }>({ open: false, user: null, type: '' });
  const { toast } = useToast();

  useEffect(() => {
    Promise.all([fetchStaff(), fetchManagers(), fetchTasks()]).finally(() => setLoading(false));
  }, []);

  const fetchStaff = async () => {
    try {
      const response: any = await apiClient.get('/users', { role: 'staff' });

      let staffData: any[] = [];
      if (response && response.users && Array.isArray(response.users)) {
        staffData = response.users;
      } else if (response && response.data && Array.isArray(response.data.users)) {
        staffData = response.data.users;
      } else if (Array.isArray(response)) {
        staffData = response;
      } else if (response && Array.isArray(response.data)) {
        staffData = response.data;
      }

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

  const fetchManagers = async () => {
    try {
      const response: any = await apiClient.get('/users', { role: 'manager' });

      let managersData: any[] = [];
      if (response && response.users && Array.isArray(response.users)) {
        managersData = response.users;
      } else if (response && response.data && Array.isArray(response.data.users)) {
        managersData = response.data.users;
      } else if (Array.isArray(response)) {
        managersData = response;
      } else if (response && Array.isArray(response.data)) {
        managersData = response.data;
      }

      setManagers(Array.isArray(managersData) ? managersData : []);
    } catch (error) {
      console.error('Error fetching managers:', error);
      toast({
        title: "Error",
        description: "Failed to fetch managers",
        variant: "destructive",
      });
    }
  };

  const fetchTasks = async () => {
    try {
      const response: any = await apiClient.getTasks();

      let tasksData = [];
      if (response && response.data && Array.isArray(response.data)) {
        tasksData = response.data;
      } else if (Array.isArray(response)) {
        tasksData = response;
      }

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
      
      if (!name) return false;
      
      if (searchTermLower) {
        return (typeof name === 'string' && name.toLowerCase().includes(searchTermLower)) ||
               (typeof position === 'string' && position.toLowerCase().includes(searchTermLower));
      }
      
      return true;
    } catch (error) {
      console.error('Error filtering staff member:', error, member);
      return false;
    }
  });

  const filteredManagers = managers.filter(member => {
    try {
      const name = member?.fullName || member?.name || '';
      const position = member?.role || '';
      const searchTermLower = searchTerm.toLowerCase();
      
      if (!name) return false;
      
      if (searchTermLower) {
        return (typeof name === 'string' && name.toLowerCase().includes(searchTermLower)) ||
               (typeof position === 'string' && position.toLowerCase().includes(searchTermLower));
      }
      
      return true;
    } catch (error) {
      console.error('Error filtering manager:', error, member);
      return false;
    }
  });

  const filteredTasks = tasks.filter(task => {
    try {
      const title = task?.title || '';
      const assignedStaff = task?.assignedTo;
      let staffName = '';
      
      if (assignedStaff) {
        if (typeof assignedStaff === 'string') {
          staffName = assignedStaff;
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
  
  const completedTasks = tasks.filter(task => task.status === "completed").length;
  const overdueTasks = tasks.filter(task => {
    if (!task.due_date || task.status === "completed") return false;
    const dueDate = new Date(task.due_date);
    const now = new Date();
    return dueDate < now;
  }).length;
  const activeStaff = staff.filter(member => member?.isActive === true).length;
  const activeManagers = managers.filter(member => member?.isActive === true).length;

  const buildStaffCardProps = (member: any, fallbackRole: string, fallbackDept: string) => {
    const memberId = member._id || member.id;
    const isAssignedTo = (task: any) => {
      const assignedTo = task.assignedTo;
      if (typeof assignedTo === 'string') return assignedTo === memberId;
      return assignedTo?._id === memberId;
    };

    return {
      id: memberId,
      name: member.fullName || member.name || `Unknown ${fallbackRole}`,
      role: member.role || fallbackRole,
      department: member.department || fallbackDept,
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
      activeTasks: tasks.filter(task => isAssignedTo(task) && task.status !== 'completed').length,
      completedTasks: tasks.filter(task => isAssignedTo(task) && task.status === 'completed').length,
      status: member.isActive ? 'active' : 'inactive',
      accountStatus: member.status
    };
  };

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
    setSelectedTask(task);
    setShowEditTaskDialog(true);
  };

  const handleComment = (task: any) => {
    setSelectedTask(task);
    setShowCommentDialog(true);
  };

  const handleComplete = async (task: any) => {
    try {
      await apiClient.updateTaskStatus(task._id || task.id, 'completed');
      toast({
        title: "Task Completed",
        description: "Task has been marked as completed",
      });
      fetchTasks();
    } catch (error: any) {
      console.error('Error completing task:', error);
      toast({
        title: "Error",
        description: error.response?.data?.message || "Failed to complete task",
        variant: "destructive",
      });
    }
  };

  const handleDeleteClick = (user: any, type: string) => {
    setDeleteDialog({ open: true, user, type });
  };

  const handleDeleteConfirm = async () => {
    try {
      await apiClient.deleteUser(deleteDialog.user._id || deleteDialog.user.id);
      toast({
        title: "User Deleted",
        description: `${deleteDialog.type} has been deleted successfully`,
      });
      
      if (deleteDialog.type === 'Manager') {
        fetchManagers();
      } else {
        fetchStaff();
      }
      
      setDeleteDialog({ open: false, user: null, type: '' });
    } catch (error: any) {
      console.error('Error deleting user:', error);
      toast({
        title: "Error",
        description: error.response?.data?.message || "Failed to delete user",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Staff & Task Management</h1>
          <p className="text-muted-foreground text-sm">Manage team members, edit credentials, and assign tasks</p>
        </div>
        <Button onClick={() => setShowCreateTaskDialog(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          Create Task
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Users className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Active Staff</p>
              <p className="text-xl font-bold">{activeStaff}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Shield className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Active Managers</p>
              <p className="text-xl font-bold">{activeManagers}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Completed Tasks</p>
              <p className="text-xl font-bold">{completedTasks}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-destructive" />
            <div>
              <p className="text-xs text-muted-foreground">Overdue Tasks</p>
              <p className="text-xl font-bold text-destructive">{overdueTasks}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search staff, managers or tasks..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Tabs */}
      <Tabs defaultValue="staff" className="space-y-6">
        <TabsList>
          <TabsTrigger value="staff">Staff</TabsTrigger>
          <TabsTrigger value="managers">Managers</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
        </TabsList>
        
        <TabsContent value="staff">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">All Staff</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
                  Loading staff...
                </div>
              ) : filteredStaff.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                  <User className="h-10 w-10 text-muted-foreground opacity-40" />
                  <h3 className="text-lg font-semibold">No staff found</h3>
                  <p className="text-muted-foreground text-sm max-w-sm">No staff members match your search criteria.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-4 py-3 font-medium">Name</th>
                        <th className="text-left px-4 py-3 font-medium">Contact</th>
                        <th className="text-left px-4 py-3 font-medium">Tasks</th>
                        <th className="text-left px-4 py-3 font-medium">Next Shift</th>
                        <th className="text-left px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredStaff.map((member) => (
                        <StaffCard
                          key={member._id || member.id}
                          staff={buildStaffCardProps(member, 'Staff', 'General')}
                          onSchedule={() => handleScheduleClick(member)}
                          onStaffUpdated={fetchStaff}
                          onDelete={() => handleDeleteClick(member, 'Staff')}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="managers">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">All Managers</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
                  Loading managers...
                </div>
              ) : filteredManagers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                  <Shield className="h-10 w-10 text-muted-foreground opacity-40" />
                  <h3 className="text-lg font-semibold">No managers found</h3>
                  <p className="text-muted-foreground text-sm max-w-sm">No managers match your search criteria.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-4 py-3 font-medium">Name</th>
                        <th className="text-left px-4 py-3 font-medium">Contact</th>
                        <th className="text-left px-4 py-3 font-medium">Tasks</th>
                        <th className="text-left px-4 py-3 font-medium">Next Shift</th>
                        <th className="text-left px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredManagers.map((member) => (
                        <StaffCard
                          key={member._id || member.id}
                          staff={buildStaffCardProps(member, 'Manager', 'Management')}
                          onSchedule={() => handleScheduleClick(member)}
                          onStaffUpdated={fetchManagers}
                          onDelete={() => handleDeleteClick(member, 'Manager')}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tasks">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">All Tasks</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
                  Loading tasks...
                </div>
              ) : filteredTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                  <Clock className="h-10 w-10 text-muted-foreground opacity-40" />
                  <h3 className="text-lg font-semibold">No tasks found</h3>
                  <p className="text-muted-foreground text-sm max-w-sm">No tasks match your search criteria.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-4 py-3 font-medium">Task</th>
                        <th className="text-left px-4 py-3 font-medium">Assigned To</th>
                        <th className="text-left px-4 py-3 font-medium">Priority</th>
                        <th className="text-left px-4 py-3 font-medium">Status</th>
                        <th className="text-left px-4 py-3 font-medium">Due Date</th>
                        <th className="px-4 py-3 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTasks.map((task) => (
                        <TaskCard key={task._id || task.id} task={task} onEdit={handleEditTask} onComment={handleComment} onComplete={handleComplete} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => setDeleteDialog(prev => ({ ...prev, open }))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteDialog.type}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {deleteDialog.user?.fullName || deleteDialog.user?.name}? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
          fetchStaff();
        }}
      />
    </div>
  );
}
