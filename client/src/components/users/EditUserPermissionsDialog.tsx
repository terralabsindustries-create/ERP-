import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2 } from "lucide-react";
import apiClient from "@/lib/apiClient";
import { useAuth } from "@/contexts/AuthContext";
import { PermissionSelector } from "./PermissionSelector";
import { ViewAllDataOption, VIEW_ALL_ROLES, canGrantViewAll } from "./ViewAllDataOption";

interface EditUserPermissionsDialogProps {
  user: any | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/**
 * Changes a login's role and permissions after it was created. Takes effect on
 * the user's next request — the backend reads permissions from the database on
 * every call, so nothing needs to be re-issued.
 */
export function EditUserPermissionsDialog({
  user,
  open,
  onOpenChange,
  onSaved,
}: EditUserPermissionsDialogProps) {
  const { user: currentUser } = useAuth();
  const canGrantViewAllData = canGrantViewAll(currentUser);
  const [role, setRole] = useState("staff");
  const [permissions, setPermissions] = useState<string[]>(["Dashboard"]);
  const [canViewAllData, setCanViewAllData] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  // Reload from the user each time the dialog opens so an abandoned edit is
  // never carried into the next one.
  useEffect(() => {
    if (!open || !user) return;
    setRole(user.role || "staff");
    const current = Array.isArray(user.permissions) ? user.permissions : [];
    setPermissions(current.includes("Dashboard") ? current : ["Dashboard", ...current]);
    setCanViewAllData(user.canViewAllData === true);
    setError("");
  }, [open, user]);

  const handleSave = async () => {
    if (!user) return;
    setError("");
    setIsSaving(true);

    try {
      await apiClient.updateUser(user._id || user.id, {
        role,
        permissions,
        // Left out when this login can't grant it, so the backend keeps the
        // current value (and still clears it if the role changes to staff).
        ...(canGrantViewAllData && {
          canViewAllData: VIEW_ALL_ROLES.includes(role) && canViewAllData,
        }),
      });
      onSaved();
      onOpenChange(false);
    } catch (e: any) {
      setError(e.message || "Could not save the changes. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit access for {user?.fullName}</DialogTitle>
          <DialogDescription>
            {user?.email}
            {user?.status === "invited" && " — invitation not accepted yet, changes still apply"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-role" className="font-semibold">
              User Role
            </Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="edit-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manager">Manager</SelectItem>
                <SelectItem value="accountant">Accountant</SelectItem>
                <SelectItem value="staff">Staff</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {canGrantViewAllData && VIEW_ALL_ROLES.includes(role) && (
            <ViewAllDataOption
              id="edit-view-all"
              checked={canViewAllData}
              onChange={setCanViewAllData}
            />
          )}

          <PermissionSelector value={permissions} onChange={setPermissions} />

          {error && (
            <Alert className="bg-destructive/10 border-destructive/30 text-destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
