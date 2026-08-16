import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Phone, Mail, Edit, Calendar, Loader2, Key, Trash2, MailIcon, MoreHorizontal } from "lucide-react";
import apiClient from "@/lib/apiClient";
import { EditStaffDialog } from "./EditStaffDialog";
import { StaffCredentialsDialog } from "./StaffCredentialsDialog";
import { useToast } from "@/hooks/use-toast";

interface Schedule {
  _id: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  shiftType: 'morning' | 'afternoon' | 'evening' | 'night';
}

interface StaffCardProps {
  staff: {
    id: string;
    name: string;
    role: string;
    department: string;
    email: string;
    phone: string;
    activeTasks: number;
    completedTasks: number;
    status: string;
    fullName?: string;
    isActive?: boolean;
    companyName?: string;
    dataScope?: string;
    permissions?: string[];
    avatar?: string;
    lastLogin?: string;
    createdAt?: string;
    updatedAt?: string;
    // Login lifecycle: 'invited' until they accept and set a password.
    accountStatus?: string;
  };
  onSchedule?: () => void;
  onStaffUpdated?: () => void;
  onDelete?: () => void;
}

export function StaffCard({ staff, onSchedule, onStaffUpdated, onDelete }: StaffCardProps) {
  const [nextShift, setNextShift] = useState<any>(null);
  const [isLoadingSchedule, setIsLoadingSchedule] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showCredentialsDialog, setShowCredentialsDialog] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const { toast } = useToast();

  const isInvited = staff.accountStatus === "invited";

  const handleResendInvitation = async () => {
    try {
      setIsResending(true);
      const response: any = await apiClient.resendInvitation(staff.id);
      toast({
        title: "Invitation sent",
        description: response?.message || `A new invitation link was emailed to ${staff.email}.`,
      });
      onStaffUpdated?.();
    } catch (error: any) {
      toast({
        title: "Could not resend the invitation",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsResending(false);
    }
  };

  useEffect(() => {
    if (staff.id) {
      fetchNextShift();
    }
  }, [staff.id]);

  const fetchNextShift = async () => {
    try {
      setIsLoadingSchedule(true);
      console.log(`📅 Fetching schedule for staff ${staff.id} (${staff.name})`);
      
      const response = await apiClient.getStaffSchedule(staff.id) as any;
      console.log(`📅 Schedule response for ${staff.name}:`, response);
      
      // Handle different response structures
      let schedules: Schedule[] = [];
      if (response && response.data && Array.isArray(response.data)) {
        schedules = response.data;
      } else if (response && Array.isArray(response)) {
        schedules = response;
      } else if (response && (response as any).success && (response as any).data && Array.isArray((response as any).data)) {
        schedules = (response as any).data;
      }
      
      console.log(`📅 Processed schedules for ${staff.name}:`, schedules);
      
      if (schedules && schedules.length > 0) {
        // Get current day and find today's schedule
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        console.log(`📅 Today is: ${today}`);
        
        const todaySchedule = schedules.find((s: Schedule) => 
          s.dayOfWeek.toLowerCase() === today.toLowerCase()
        );
        
        console.log(`📅 Today's schedule for ${staff.name}:`, todaySchedule);
        
        if (todaySchedule) {
          setNextShift(todaySchedule);
        } else {
          // If no schedule for today, get the next available shift
          console.log(`📅 No schedule for today, using first available for ${staff.name}`);
          setNextShift(schedules[0]);
        }
      } else {
        console.log(`📅 No schedules found for ${staff.name}`);
        setNextShift(null);
      }
    } catch (error) {
      console.error(`❌ Error fetching schedule for ${staff.name}:`, error);
      setNextShift(null);
    } finally {
      setIsLoadingSchedule(false);
    }
  };

  const formatShiftTime = (schedule: Schedule | null) => {
    if (!schedule) return 'No schedule';
    return `${schedule.startTime} - ${schedule.endTime}`;
  };

  return (
    <>
      <tr className="border-b hover:bg-muted/30 transition-colors">
        <td className="px-4 py-3">
          <div className="font-medium">{staff.name}</div>
          <div className="text-xs text-muted-foreground">{staff.role} • {staff.department}</div>
        </td>
        <td className="px-4 py-3 text-muted-foreground">
          {staff.phone && (
            <div className="flex items-center gap-1">
              <Phone className="h-3 w-3" />
              {staff.phone}
            </div>
          )}
          <div className="flex items-center gap-1 text-xs">
            <Mail className="h-3 w-3" />
            {staff.email}
          </div>
        </td>
        <td className="px-4 py-3">
          <div>{staff.activeTasks} active</div>
          <div className="text-xs text-muted-foreground">{staff.completedTasks} completed</div>
        </td>
        <td className="px-4 py-3 text-muted-foreground">
          {isLoadingSchedule ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading...
            </div>
          ) : nextShift ? (
            <>
              <div>{nextShift.dayOfWeek}, {formatShiftTime(nextShift)}</div>
              <div className="text-xs capitalize">{nextShift.shiftType} Shift</div>
            </>
          ) : (
            <span className="text-xs">No scheduled shifts</span>
          )}
        </td>
        <td className="px-4 py-3">
          {isInvited ? (
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
              Invited
            </Badge>
          ) : (
            <Badge variant={staff.status === "active" ? "success" : "secondary"}>
              {staff.status}
            </Badge>
          )}
        </td>
        <td className="px-4 py-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuItem onClick={onSchedule}>
                <Calendar className="h-4 w-4 mr-2" />
                Schedule
              </DropdownMenuItem>
              {isInvited ? (
                // No password exists yet, so there is nothing to reset — the only
                // useful action is putting a fresh link in their inbox.
                <DropdownMenuItem onClick={handleResendInvitation} disabled={isResending}>
                  {isResending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <MailIcon className="h-4 w-4 mr-2" />
                  )}
                  Resend Invite
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setShowCredentialsDialog(true)}>
                  <Key className="h-4 w-4 mr-2" />
                  Password
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setShowEditDialog(true)}>
                <Edit className="h-4 w-4 mr-2" />
                Edit
              </DropdownMenuItem>
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </td>
      </tr>

      {/* Edit Staff Dialog */}
      <EditStaffDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        staff={staff}
        onStaffUpdated={() => {
          onStaffUpdated?.();
          setShowEditDialog(false);
        }}
      />

      {/* Staff Credentials Dialog */}
      <StaffCredentialsDialog
        open={showCredentialsDialog}
        onOpenChange={setShowCredentialsDialog}
        staff={{
          id: staff.id,
          name: staff.name,
          email: staff.email,
          role: staff.role,
          status: staff.status
        }}
        onStaffUpdated={() => {
          onStaffUpdated?.();
          setShowCredentialsDialog(false);
        }}
      />
    </>
  );
}
