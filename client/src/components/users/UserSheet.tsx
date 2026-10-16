import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Lock, Mail, Send, UsersRound } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAuth } from "@/contexts/AuthContext";
import apiClient from "@/lib/apiClient";
import {
  BASE_ROLES,
  VIEW_ALL_ROLES,
  grantedModules,
  moduleLabel,
  type AccessRoleRecord,
  type BaseRole,
  type ManagedUser,
  type TeamRecord
} from "@/lib/userAdmin";
import { cn } from "@/lib/utils";
import { EditorSection, EditorSheet } from "./EditorSheet";
import { PermissionMatrix } from "./PermissionMatrix";

const CUSTOM = "custom";

interface UserSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The login to edit; null to invite someone new. */
  user: ManagedUser | null;
  roles: AccessRoleRecord[];
  teams: TeamRecord[];
  onSaved: (message: string) => void;
}

/**
 * Invite a person or change one: details, a role (or access set one permission
 * at a time) and their teams. What the signed-in login cannot hand out is
 * locked, matching the API's rule that you only grant what you hold.
 */
export function UserSheet({ open, onOpenChange, user, roles, teams, onSaved }: UserSheetProps) {
  const { user: me, hasPermission } = useAuth();
  const inviting = !user;
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [department, setDepartment] = useState("");
  const [roleChoice, setRoleChoice] = useState<string>("");
  const [customRole, setCustomRole] = useState<BaseRole>("staff");
  const [customPerms, setCustomPerms] = useState<string[]>(["Dashboard"]);
  const [customViewAll, setCustomViewAll] = useState(false);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Start from the person each time the panel opens, so an abandoned edit is
  // never carried into the next one.
  useEffect(() => {
    if (!open) return;
    setFullName(user?.fullName || "");
    setEmail(user?.email || "");
    setDepartment(user?.department || "");
    setRoleChoice(user ? user.accessRole || CUSTOM : "");
    setCustomRole(user?.role === "manager" || user?.role === "accountant" ? user.role : "staff");
    setCustomPerms(user?.permissions?.length ? user.permissions : ["Dashboard"]);
    setCustomViewAll(user?.canViewAllData === true);
    setTeamIds(user?.teams?.map((t) => t._id) || []);
    setError("");
  }, [open, user]);

  const canGrantViewAll = me?.role === "admin" || me?.canViewAllData === true;
  const selectedRole = roles.find((r) => r._id === roleChoice) || null;
  const isCustom = roleChoice === CUSTOM;

  const unchangedRole = !!user && user.accessRole === roleChoice;
  const changeSummary = useMemo(() => {
    if (!selectedRole) return null;
    const mods = grantedModules(selectedRole.permissions);
    if (!mods.length) return "Opens the dashboard only.";
    return `Opens ${mods.length} section${mods.length === 1 ? "" : "s"}: ${mods.slice(0, 6).map(moduleLabel).join(", ")}${mods.length > 6 ? ` and ${mods.length - 6} more` : ""}.`;
  }, [selectedRole]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!fullName.trim() || !email.trim()) return setError("Enter their name and email address.");
    if (!roleChoice) return setError("Choose a role, or Custom access.");

    const access = isCustom
      ? {
          accessRoleId: null,
          role: customRole,
          permissions: customPerms,
          ...(canGrantViewAll && { canViewAllData: VIEW_ALL_ROLES.includes(customRole) && customViewAll })
        }
      : { accessRoleId: roleChoice };

    setSaving(true);
    try {
      if (inviting) {
        await apiClient.createUser({
          fullName: fullName.trim(),
          email: email.trim().toLowerCase(),
          department: department.trim(),
          teamIds,
          ...access
        });
        onSaved(`Invitation sent to ${email.trim()}. They set their own password from the email.`);
      } else {
        await apiClient.updateUser(user._id, {
          fullName: fullName.trim(),
          ...(email.trim().toLowerCase() !== user.email ? { email: email.trim().toLowerCase() } : {}),
          teamIds,
          // Leave the role alone when it didn't change, so a role edit made
          // meanwhile by someone else isn't overwritten with a stale copy.
          ...(unchangedRole && !isCustom ? {} : access)
        });
        onSaved(`${fullName.trim()}'s access was updated. It applies from their next action.`);
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorSheet
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      wide={isCustom}
      onSubmit={submit}
      title={inviting ? "Invite a team member" : `Edit ${user?.fullName}`}
      description={
        inviting
          ? "They get an email link and choose their own password. You never handle it."
          : user?.status === "invited"
            ? `${user.email} · invitation not accepted yet; changes still apply`
            : user?.email
      }
      footer={
        <>
          {error ? (
            <p role="alert" className="text-sm text-destructive-strong sm:mr-auto">{error}</p>
          ) : (
            inviting && (
              <p className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:mr-auto sm:flex">
                <Mail className="h-3.5 w-3.5" /> They'll get an email link to set their password.
              </p>
            )
          )}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : inviting ? <Send /> : null}
            {inviting ? "Send invitation" : "Save changes"}
          </Button>
        </>
      }
    >
      <EditorSection title="Details">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="um-name">Full name</Label>
            <Input id="um-name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Anu Joseph" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="um-email">Email</Label>
            <Input id="um-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="anu@yourshop.in" autoComplete="off" />
          </div>
          {inviting && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="um-dept">Department <span className="font-normal text-muted-foreground">(optional, fills in their HR record)</span></Label>
              <Input id="um-dept" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Pre-press, Accounts, Dispatch…" />
            </div>
          )}
        </div>
        {!inviting && user?.status === "invited" && email.trim().toLowerCase() !== user.email && (
          <p className="flex items-start gap-2 rounded-md bg-info-soft px-3 py-2 text-xs text-info-strong">
            <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The old invitation link stops working and a new one is sent to the new address.
          </p>
        )}
      </EditorSection>

      <EditorSection title="Access" description="Pick a role, a saved set of permissions. Editing that role later updates everyone on it.">
        <div className="space-y-1.5">
          <Label htmlFor="um-role">Role</Label>
          <Select value={roleChoice} onValueChange={setRoleChoice}>
            <SelectTrigger id="um-role" className={cn(!roleChoice && "text-muted-foreground")}>
              <SelectValue placeholder="Choose a role" />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              <SelectGroup>
                <SelectLabel>Roles</SelectLabel>
                {roles.map((r) => (
                  <SelectItem key={r._id} value={r._id} disabled={!r.editable}>
                    <span className="flex items-center gap-2">
                      {r.name}
                      <span className="text-xs text-muted-foreground">{BASE_ROLES[r.baseRole]?.label}</span>
                      {!r.editable && <Lock className="h-3 w-3 text-muted-foreground" />}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectSeparator />
              <SelectItem value={CUSTOM}>Custom access (set permissions one by one)</SelectItem>
            </SelectContent>
          </Select>
          {roles.some((r) => !r.editable) && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" /> Locked roles include access you don't hold yourself.
            </p>
          )}
        </div>

        {selectedRole && (
          <div className="rounded-lg border bg-muted/20">
            <div className="space-y-2 px-3 py-3 sm:px-4">
              {selectedRole.description && <p className="text-sm">{selectedRole.description}</p>}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Account type</dt>
                  <dd className="font-medium">{BASE_ROLES[selectedRole.baseRole]?.label}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Records</dt>
                  <dd className="font-medium">{selectedRole.canViewAllData ? "Everyone's" : "Their own"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">People with this role</dt>
                  <dd className="font-medium">{selectedRole.userCount}</dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">{changeSummary}</p>
            </div>
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 border-t px-3 py-2 text-left text-xs font-medium text-primary hover:bg-muted/40 sm:px-4">
                View all permissions
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t p-3 sm:p-4">
                <PermissionMatrix value={selectedRole.permissions} readOnly />
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        {isCustom && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="um-type">Account type</Label>
                <Select value={customRole} onValueChange={(v) => setCustomRole(v as BaseRole)}>
                  <SelectTrigger id="um-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(BASE_ROLES) as BaseRole[]).map((k) => (
                      <SelectItem key={k} value={k}>{BASE_ROLES[k].label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{BASE_ROLES[customRole].description}</p>
              </div>
              {VIEW_ALL_ROLES.includes(customRole) && canGrantViewAll && (
                <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 sm:mt-6">
                  <label htmlFor="um-viewall" className="cursor-pointer">
                    <span className="block text-sm font-medium">Can view all staff data</span>
                    <span className="block text-xs text-muted-foreground">Records created by everyone, not only their own.</span>
                  </label>
                  <Switch id="um-viewall" checked={customViewAll} onCheckedChange={setCustomViewAll} />
                </div>
              )}
            </div>
            <PermissionMatrix value={customPerms} onChange={setCustomPerms} canGrant={hasPermission} />
          </div>
        )}
      </EditorSection>

      <EditorSection title="Teams" description="Optional. Teams group people who work together; they don't change access.">
        {teams.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
            <UsersRound className="h-4 w-4" />
            No teams yet. You can create them on the Teams tab.
          </p>
        ) : (
          <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2" role="group" aria-label="Teams">
            {teams.map((t) => {
              const id = `um-team-${t._id}`;
              const on = teamIds.includes(t._id);
              return (
                <label key={t._id} htmlFor={id} className={cn("flex cursor-pointer items-center gap-3 bg-card px-3 py-2.5", on && "bg-primary-soft/30")}>
                  <Checkbox id={id} checked={on} onCheckedChange={() => setTeamIds(on ? teamIds.filter((x) => x !== t._id) : [...teamIds, t._id])} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{t.name}</span>
                    <span className="block text-xs text-muted-foreground">{t.members.length} {t.members.length === 1 ? "member" : "members"}</span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </EditorSection>
    </EditorSheet>
  );
}
