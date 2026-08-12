import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Mail, Users, Loader2 } from "lucide-react";
import apiClient from "@/lib/apiClient";
import { PERMISSION_TREE, ALL_PERMISSIONS, actionName, actionsForModule } from "@/lib/permissions";

// Permission catalogue is shared with the backend enum — see src/lib/permissions.ts
const permissionsList = ALL_PERMISSIONS;

export default function CreateLogin() {
  const [formData, setFormData] = useState({
    role: "",
    email: "",
    fullName: "",
    department: "",
  });

  const [permissions, setPermissions] = useState([]);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [isLoading, setIsLoading] = useState(false);
  const [seats, setSeats] = useState(null);

  useEffect(() => {
    if (formData.role === "manager" || formData.role === "staff") {
      // Managers and staff pick their own permissions - start with Dashboard only
      if (permissions.length === 0) {
        setPermissions(["Dashboard"]);
      }
    }
  }, [formData.role]);

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

  useEffect(() => {
    loadSeats();
  }, []);

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

  // Toggling a MODULE. Granting one turns on its "View" action so the user can
  // actually open the section; revoking one drops every action beneath it, so a
  // stored list never implies access to a section the user cannot reach.
  const handleModuleToggle = (module, e) => {
    if (e) e.stopPropagation();

    setPermissions((prev) => {
      const children = actionsForModule(module);
      if (prev.includes(module)) {
        return prev.filter((p) => p !== module && !children.includes(p));
      }
      const viewAction = actionName(module, "View");
      const next = [...prev, module];
      if (children.includes(viewAction)) next.push(viewAction);
      return next;
    });
  };

  // Toggling an ACTION. Only reachable when its module is already granted.
  const handleActionToggle = (action, e) => {
    if (e) e.stopPropagation();

    setPermissions((prev) =>
      prev.includes(action) ? prev.filter((p) => p !== action) : [...prev, action]
    );
  };

  // Kept for the "Dashboard is always on" case and any legacy caller.
  const handlePermissionToggle = handleModuleToggle;

  const toggleAllPermissions = () => {
    if (permissions.length === permissionsList.length) {
      setPermissions([]);
    } else {
      setPermissions([...permissionsList]);
    }
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
        isActive: true,
      };

      console.log("📝 Inviting user with data:", userData);

      const response = await apiClient.createUser(userData);

      console.log("✅ Invitation sent:", response);

      // Reflect the seat we just consumed
      await loadSeats();

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
    setPermissions([]);
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
                      <SelectItem value="staff">Staff - Custom Permissions</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Logins created here are manager or staff accounts. Admin accounts are created
                    through signup only.
                  </p>
                </div>

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

              {/* Permissions Section */}
              <div className="space-y-4 p-6 bg-muted rounded-lg border border-input">
                <div className="flex justify-between items-center gap-4">
                  <div className="space-y-1">
                    <h3 className="text-lg font-semibold">Permissions</h3>
                    {formData.role === "admin" ? (
                      <p className="text-xs text-green-600 font-medium">Admin automatically gets full access to all features</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select only the features this user should access</p>
                    )}
                    {formData.role && (
                      <div className="flex items-center gap-2 pt-2">
                        <div
                          className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                            formData.role === "admin"
                              ? "bg-green-100 text-green-700"
                              : formData.role === "manager"
                              ? "bg-primary/10 text-primary"
                              : "bg-secondary/10 text-secondary"
                          }`}
                        >
                          {formData.role === "admin" ? "Admin - Full Access" : formData.role === "manager" ? "Manager - Custom Permissions" : "Staff - Custom Permissions"}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {permissions.length} / {permissionsList.length} selected
                        </span>
                      </div>
                    )}
                  </div>
                  {formData.role !== "admin" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={toggleAllPermissions}
                      className="whitespace-nowrap"
                    >
                      {permissions.length === permissionsList.length ? "Deselect All" : "Select All"}
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {PERMISSION_TREE.map(({ module, actions }) => {
                    const isAdminRole = formData.role === "admin";
                    const isDashboard = module === "Dashboard";
                    const moduleLocked = isAdminRole || isDashboard;
                    const moduleGranted = permissions.includes(module);

                    return (
                      <div
                        key={module}
                        className={`rounded-lg border transition-all ${
                          isAdminRole
                            ? "border-green-200 bg-green-50"
                            : isDashboard
                            ? "border-primary/50 bg-primary/5"
                            : moduleGranted
                            ? "border-primary/40 bg-card"
                            : "border-input bg-card"
                        }`}
                      >
                        {/* Module */}
                        <div className="flex items-center space-x-2 p-3">
                          <Checkbox
                            id={module}
                            checked={moduleGranted}
                            disabled={moduleLocked}
                            onCheckedChange={() => {
                              if (!moduleLocked) handleModuleToggle(module);
                            }}
                          />
                          <label
                            htmlFor={module}
                            className={`text-sm font-semibold flex-1 ${
                              moduleLocked ? "cursor-not-allowed" : "cursor-pointer"
                            } ${
                              isAdminRole
                                ? "text-green-700"
                                : isDashboard
                                ? "text-primary"
                                : ""
                            }`}
                            onClick={(e) => {
                              if (!moduleLocked) {
                                e.preventDefault();
                                handleModuleToggle(module);
                              }
                            }}
                          >
                            {module}
                            {isAdminRole && <span className="text-xs text-green-700 ml-1">(Auto)</span>}
                            {isDashboard && !isAdminRole && <span className="text-xs text-primary ml-1">(Required)</span>}
                          </label>
                          {actions.length > 0 && !isAdminRole && (
                            <span className="text-[11px] text-muted-foreground">
                              {actions.filter((a) => permissions.includes(actionName(module, a))).length}/{actions.length}
                            </span>
                          )}
                        </div>

                        {/* Actions inside this module — greyed out until the module is granted */}
                        {actions.length > 0 && (
                          <div className="pl-9 pr-3 pb-3 space-y-1.5">
                            {actions.map((action) => {
                              const perm = actionName(module, action);
                              const disabled = isAdminRole || !moduleGranted;
                              return (
                                <div key={perm} className="flex items-center space-x-2">
                                  <Checkbox
                                    id={perm}
                                    checked={permissions.includes(perm)}
                                    disabled={disabled}
                                    onCheckedChange={() => {
                                      if (!disabled) handleActionToggle(perm);
                                    }}
                                  />
                                  <label
                                    htmlFor={perm}
                                    className={`text-xs flex-1 ${
                                      disabled
                                        ? "text-muted-foreground/50 cursor-not-allowed"
                                        : "cursor-pointer"
                                    }`}
                                    onClick={(e) => {
                                      if (!disabled) {
                                        e.preventDefault();
                                        handleActionToggle(perm);
                                      }
                                    }}
                                  >
                                    {action}
                                  </label>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

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
      </div>
    </div>
  );
}