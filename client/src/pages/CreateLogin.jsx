import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Mail, Users, Loader2, Pencil, ShieldCheck, Trash2 } from "lucide-react";
import apiClient from "@/lib/apiClient";
import { useAuth } from "@/contexts/AuthContext";
import { PermissionSelector } from "@/components/users/PermissionSelector";
import { EditUserPermissionsDialog } from "@/components/users/EditUserPermissionsDialog";
import { ViewAllDataOption, VIEW_ALL_ROLES, canGrantViewAll } from "@/components/users/ViewAllDataOption";

export default function CreateLogin() {
  const { user: currentUser } = useAuth();
  // Only an admin may remove a login — the backend enforces the same rule, so
  // showing the button to a manager would only produce a 403.
  const canDelete = currentUser?.role === "admin";
  const canGrantViewAllData = canGrantViewAll(currentUser);

  const [formData, setFormData] = useState({
    role: "",
    email: "",
    fullName: "",
    department: "",
  });

  const [permissions, setPermissions] = useState(["Dashboard"]);
  const [canViewAllData, setCanViewAllData] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [isLoading, setIsLoading] = useState(false);
  const [seats, setSeats] = useState(null);
  const [team, setTeam] = useState([]);
  const [isLoadingTeam, setIsLoadingTeam] = useState(true);
  const [editingUser, setEditingUser] = useState(null);
  const [deletingUser, setDeletingUser] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // How many of the admin's staff/manager logins are already taken. The backend
  // enforces the same limit; this only keeps the form honest about it.
  const loadSeats = async () => {
    try {
      const response = await apiClient.getUserStats();
      const staffSeats = response?.stats?.staffSeats;
      if (staffSeats) setSeats(staffSeats);
    } catch (error) {
      console.error("❌ Error loading staff seat usage:", error);
    }
  };

  // The logins this admin has already handed out. Admins are left out: they
  // always hold every permission, so there is nothing to edit.
  const loadTeam = async () => {
    try {
      setIsLoadingTeam(true);
      const response = await apiClient.getUsers({ limit: 100 });
      const users = response?.users || [];
      setTeam(users.filter((u) => u.role !== "admin"));
    } catch (error) {
      console.error("❌ Error loading team logins:", error);
    } finally {
      setIsLoadingTeam(false);
    }
  };

  useEffect(() => {
    loadSeats();
    loadTeam();
  }, []);

  const handleDelete = async () => {
    if (!deletingUser) return;
    setIsDeleting(true);

    try {
      await apiClient.deleteUser(deletingUser._id || deletingUser.id);
      setMessage({
        type: "success",
        text: deletingUser.status === "invited"
          ? `✓ Invitation to ${deletingUser.email} cancelled. That seat is free again.`
          : `✓ ${deletingUser.fullName}'s login was removed. That seat is free again.`,
      });
      setDeletingUser(null);
      await loadTeam();
      await loadSeats();
    } catch (error) {
      console.error("❌ Error deleting login:", error);
      setMessage({ type: "error", text: error.message || "Failed to remove the login." });
      setDeletingUser(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const seatsFull = seats ? seats.remaining <= 0 : false;

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleRoleChange = (value) => {
    setFormData((prev) => ({
      ...prev,
      role: value,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);

    // Validation
    if (!formData.role || !formData.email || !formData.fullName) {
      setMessage({ type: "error", text: "Please fill in all required fields." });
      setIsLoading(false);
      return;
    }

    if (permissions.length === 0) {
      setMessage({ type: "error", text: "Please select at least one permission." });
      setIsLoading(false);
      return;
    }

    if (seatsFull) {
      setMessage({
        type: "error",
        text: `Staff limit reached — you can create up to ${seats.limit} staff/manager logins. Delete an existing login to free a slot.`,
      });
      setIsLoading(false);
      return;
    }

    try {
      // No password here — the backend emails a one-time link and the invitee
      // sets their own on the Create Password page.
      const userData = {
        role: formData.role,
        email: formData.email.toLowerCase().trim(),
        fullName: formData.fullName.trim(),
        department: formData.department.trim(),
        permissions: permissions,
        canViewAllData: canGrantViewAllData && VIEW_ALL_ROLES.includes(formData.role) && canViewAllData,
        isActive: true,
      };

      console.log("📝 Inviting user with data:", userData);

      const response = await apiClient.createUser(userData);

      console.log("✅ Invitation sent:", response);

      // Reflect the seat we just consumed and show the new login below
      await loadSeats();
      await loadTeam();

      // Show success message
      setMessage({
        type: "success",
        text: `✓ Invitation sent to ${formData.email}. They will set their own password from the link in that email, and the account activates once they do.`,
      });

      // Reset form after 2 seconds
      setTimeout(() => {
        handleReset();
        setIsLoading(false);
      }, 2000);

    } catch (error) {
      console.error("❌ Error inviting user:", error);

      let errorMessage = "Failed to send the invitation. Please try again.";

      if (error.message) {
        errorMessage = error.message;
      }

      // Check for duplicate email error
      if (errorMessage.includes("already exists")) {
        errorMessage = "A user with this email already exists.";
      }

      setMessage({ type: "error", text: errorMessage });
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setFormData({ role: "", email: "", fullName: "", department: "" });
    setPermissions(["Dashboard"]);
    setCanViewAllData(false);
    setMessage({ type: "", text: "" });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted p-4 py-8">
      <div className="max-w-4xl mx-auto">
        <Card className="shadow-elevated">
          <CardHeader className="text-center space-y-3">
            <div className="flex justify-center">
              <div className="p-3 bg-primary/10 rounded-full">
                <Users className="h-8 w-8 text-primary" />
              </div>
            </div>
            <CardTitle className="text-2xl md:text-3xl">Invite a Team Member</CardTitle>
            <CardDescription className="text-base">
              They receive an email invitation and set their own password — you never handle it
            </CardDescription>
            {seats && (
              <div className="flex justify-center">
                <span
                  className={`px-3 py-1 rounded-full text-xs font-semibold ${
                    seatsFull
                      ? "bg-destructive/10 text-destructive"
                      : "bg-primary/10 text-primary"
                  }`}
                >
                  {seats.used} / {seats.limit} staff & manager logins used
                </span>
              </div>
            )}
          </CardHeader>

          <CardContent>
            {seatsFull && (
              <Alert className="mb-6 bg-destructive/10 border-destructive/30 text-destructive">
                <AlertDescription>
                  Staff limit reached — you can create up to {seats.limit} staff/manager logins.
                  Delete an existing login to free a slot.
                </AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* User Credentials Section */}
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="fullName" className="font-semibold">
                    Full Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="fullName"
                    name="fullName"
                    type="text"
                    placeholder="John Doe"
                    value={formData.fullName}
                    onChange={handleInputChange}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="role" className="font-semibold">
                    User Role <span className="text-destructive">*</span>
                  </Label>
                  <Select value={formData.role} onValueChange={handleRoleChange}>
                    <SelectTrigger id="role">
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manager">Manager - Custom Permissions</SelectItem>
                      <SelectItem value="accountant">Accountant - Custom Permissions</SelectItem>
                      <SelectItem value="staff">Staff - Custom Permissions</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Logins created here are manager, accountant or staff accounts. Admin accounts
                    are created through signup only.
                  </p>
                </div>

                {canGrantViewAllData && VIEW_ALL_ROLES.includes(formData.role) && (
                  <ViewAllDataOption
                    id="invite-view-all"
                    checked={canViewAllData}
                    onChange={setCanViewAllData}
                  />
                )}

                <div className="space-y-2">
                  <Label htmlFor="email" className="font-semibold">
                    Email Address <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    placeholder="user@example.com"
                    value={formData.email}
                    onChange={handleInputChange}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="department" className="font-semibold">
                    Department
                  </Label>
                  <Input
                    id="department"
                    name="department"
                    type="text"
                    placeholder="Accounts, Production, Design…"
                    value={formData.department}
                    onChange={handleInputChange}
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional. Used to fill in their HR record.
                  </p>
                </div>

                <div className="flex gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                  <Mail className="h-5 w-5 shrink-0 text-primary" />
                  <p className="text-xs text-muted-foreground">
                    No password is set here. We email a one-time invitation link that expires in
                    24 hours; the account activates once they choose their own password.
                  </p>
                </div>
              </div>

              <PermissionSelector value={permissions} onChange={setPermissions} />

              {/* Messages */}
              {message.text && (
                <Alert
                  className={
                    message.type === "success"
                      ? "bg-success/10 border-success/30 text-success"
                      : "bg-destructive/10 border-destructive/30 text-destructive"
                  }
                >
                  <AlertDescription>{message.text}</AlertDescription>
                </Alert>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleReset}
                  className="flex-1"
                  disabled={isLoading}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="flex-1 bg-gradient-primary hover:shadow-glow transition-all"
                  disabled={isLoading || seatsFull}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Sending invitation...
                    </>
                  ) : (
                    "Send Invitation"
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Existing logins — permissions can be changed at any time after the
            invite was sent, whether or not it has been accepted yet. */}
        <Card className="shadow-elevated mt-6">
          <CardHeader>
            <CardTitle className="text-xl">Team Logins</CardTitle>
            <CardDescription>
              Change what an existing manager or staff member can access
            </CardDescription>
          </CardHeader>

          <CardContent>
            {isLoadingTeam ? (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading team logins...
              </div>
            ) : team.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No logins yet. Invite someone using the form above.
              </p>
            ) : (
              <div className="space-y-2">
                {team.map((member) => (
                  <div
                    key={member._id || member.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-input p-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{member.fullName}</span>
                        <Badge variant="secondary" className="capitalize">
                          {member.role}
                        </Badge>
                        {member.status === "invited" ? (
                          <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                            Invited
                          </Badge>
                        ) : member.isActive === false ? (
                          <Badge variant="outline">Inactive</Badge>
                        ) : (
                          <Badge variant="outline" className="border-green-300 bg-green-50 text-green-700">
                            Active
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <ShieldCheck className="h-3 w-3" />
                        {(member.permissions || []).length} permissions
                        {member.canViewAllData && " · views all staff data"}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1"
                        onClick={() => setEditingUser(member)}
                      >
                        <Pencil className="h-3 w-3" />
                        Edit Access
                      </Button>
                      {canDelete && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setDeletingUser(member)}
                        >
                          <Trash2 className="h-3 w-3" />
                          {member.status === "invited" ? "Cancel Invite" : "Delete"}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <EditUserPermissionsDialog
        user={editingUser}
        open={!!editingUser}
        onOpenChange={(open) => !open && setEditingUser(null)}
        onSaved={() => {
          setMessage({ type: "success", text: "✓ Access updated." });
          loadTeam();
        }}
      />

      <AlertDialog
        open={!!deletingUser}
        onOpenChange={(open) => !open && !isDeleting && setDeletingUser(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deletingUser?.status === "invited"
                ? "Cancel this invitation?"
                : `Remove ${deletingUser?.fullName}'s login?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deletingUser?.status === "invited" ? (
                <>
                  The link sent to{" "}
                  <span className="font-semibold text-foreground">{deletingUser?.email}</span> stops
                  working and the seat is freed. You can invite that address again later.
                </>
              ) : (
                <>
                  <span className="font-semibold text-foreground">{deletingUser?.email}</span> will
                  no longer be able to sign in, and the seat is freed. Their HR record is kept as
                  inactive history, so payroll and attendance stay intact. This cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Keep</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog up while the request is in flight.
                e.preventDefault();
                handleDelete();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Removing...
                </>
              ) : deletingUser?.status === "invited" ? (
                "Cancel Invitation"
              ) : (
                "Delete Login"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}