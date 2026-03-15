import { useState, useEffect } from "react";
import { Plus, Search, UserPlus, Shield, Users, Mail, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";

interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: string;
  created_at: string;
  last_sign_in_at?: string;
}

export default function UserManagement() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const { toast } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    fetchProfiles();
  }, []);

  const fetchProfiles = async () => {
    try {
      const response = await apiClient.getUsers();
      console.log('👥 Users response:', response);
      
      // Handle different response structures
      const usersData = response?.data?.users || response?.users || response?.data || [];
      console.log('👥 Processed users data:', usersData);
      
      setProfiles(usersData);
    } catch (error) {
      console.error('Error fetching profiles:', error);
      toast({
        title: "Error",
        description: "Failed to fetch user profiles",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateRole = async (userId: string, newRole: string) => {
    try {
      console.log('🔄 Updating user role:', { userId, newRole });
      
      // Call real API to update user role
      const response = await apiClient.updateUser(userId, { role: newRole });
      console.log('🔄 Update role response:', response);
      
      setProfiles(prev => prev.map(profile => 
        profile.id === userId ? { ...profile, role: newRole } : profile
      ));
      
      toast({
        title: "Success",
        description: "User role updated successfully",
      });
    } catch (error) {
      console.error('Error updating role:', error);
      toast({
        title: "Error",
        description: "Failed to update user role",
        variant: "destructive",
      });
    }
  };

  const handleDeleteUser = async (userId: string, userName: string) => {
    if (window.confirm(`Are you sure you want to delete ${userName}? This action cannot be undone.`)) {
      try {
        // Call real API to delete user
        const response = await apiClient.deleteUser(userId);
        console.log('🗑️ Delete user response:', response);
        // TODO: Implement API call to delete user
        console.log('🗑️ Deleting user:', userId);
        
        setProfiles(prev => prev.filter(profile => profile.id !== userId));
        
        toast({
          title: "Success",
          description: `${userName} has been deleted successfully`,
        });
      } catch (error) {
        console.error('Error deleting user:', error);
        toast({
          title: "Error",
          description: "Failed to delete user",
          variant: "destructive",
        });
      }
    }
  };

  const filteredProfiles = profiles.filter(profile =>
    profile?.full_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    profile?.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    profile?.role?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getRoleColor = (role: string) => {
    switch (role) {
      case "admin":
        return "destructive";
      case "manager":
        return "default";
      case "staff":
        return "secondary";
      default:
        return "outline";
    }
  };

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Staff Management</h1>
          <p className="text-muted-foreground">Show the current staffs and managers and also will able to delete staff and managers</p>
        </div>
        <Button onClick={() => navigate('/create-login')} className="gap-2">
          <UserPlus className="h-4 w-4" />
          Create Login
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4" />
              Total Users
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{profiles.length}</div>
            <p className="text-xs text-muted-foreground">active team members</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Administrators
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{profiles.filter(p => p.role === 'admin').length}</div>
            <p className="text-xs text-muted-foreground">admin users</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Managers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{profiles.filter(p => p.role === 'manager').length}</div>
            <p className="text-xs text-muted-foreground">manager users</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4" />
              Staff Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{profiles.filter(p => p.role === 'staff').length}</div>
            <p className="text-xs text-muted-foreground">staff users</p>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <div className="flex items-center space-x-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search users..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Users List */}
      <div className="grid gap-4">
        {filteredProfiles.map((profile) => (
          <Card key={profile.id}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <Users className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold">{profile.full_name}</h3>
                    <p className="text-sm text-muted-foreground">{profile.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Joined: {new Date(profile.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                
                <div className="flex items-center space-x-4">
                  <Badge variant={getRoleColor(profile.role) as any}>
                    {profile.role}
                  </Badge>
                  
                  {(profile.role !== 'admin') && (
                  <Select
                    value={profile.role}
                    onValueChange={(newRole) => handleUpdateRole(profile.id, newRole)}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manager">Manager</SelectItem>
                      <SelectItem value="staff">Staff</SelectItem>
                    </SelectContent>
                  </Select>
                  )}
                  
                  {/* Show delete button for staff and managers, not admins */}
                  {(profile.role === 'staff' || profile.role === 'manager') && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDeleteUser(profile.id, profile.full_name)}
                      className="h-8 w-8 p-0"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {filteredProfiles.length === 0 && !loading && (
        <Card className="text-center p-8">
          <CardContent>
            <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">No users found</h3>
            <p className="text-muted-foreground mb-4">
              {searchTerm 
                ? "Try adjusting your search criteria"
                : "Start by creating your first login"
              }
            </p>
            <Button onClick={() => navigate('/create-login')}>
              <UserPlus className="h-4 w-4 mr-2" />
              Create First Login
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}