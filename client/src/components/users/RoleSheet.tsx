import { useEffect, useState } from "react";
import { Info, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/contexts/AuthContext";
import apiClient from "@/lib/apiClient";
import { BASE_ROLES, VIEW_ALL_ROLES, type AccessRoleRecord, type BaseRole } from "@/lib/userAdmin";
import { cn } from "@/lib/utils";
import { EditorSection, EditorSheet } from "./EditorSheet";
import { PermissionMatrix } from "./PermissionMatrix";

interface RoleSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The role to edit; null to create one. `copyOf` starts a new role from an existing one. */
  role: AccessRoleRecord | null;
  copyOf?: AccessRoleRecord | null;
  /** Show the role without letting it change. */
  readOnly?: boolean;
  onSaved: (message: string) => void;
}

/** Create, change or view a role: its name, account type and permissions. */
export function RoleSheet({ open, onOpenChange, role, copyOf, readOnly = false, onSaved }: RoleSheetProps) {
  const { user: me, hasPermission } = useAuth();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseRole, setBaseRole] = useState<BaseRole>("staff");
  const [viewAll, setViewAll] = useState(false);
  const [permissions, setPermissions] = useState<string[]>(["Dashboard"]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const src = role || copyOf;
    setName(role ? role.name : copyOf ? `${copyOf.name} (copy)` : "");
    setDescription(src?.description || "");
    setBaseRole(src?.baseRole || "staff");
    setViewAll(src?.canViewAllData === true);
    setPermissions(src?.permissions?.length ? src.permissions : ["Dashboard"]);
    setError("");
  }, [open, role, copyOf]);

  const canGrantViewAll = me?.role === "admin" || me?.canViewAllData === true;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    if (!name.trim()) return setError("Give the role a name.");
    setError("");
    setSaving(true);
    const body = {
      name: name.trim(),
      description: description.trim(),
      baseRole,
      permissions,
      canViewAllData: VIEW_ALL_ROLES.includes(baseRole) && viewAll
    };
    try {
      if (role) {
        const res = (await apiClient.updateAccessRole(role._id, body)) as { usersUpdated?: number };
        const n = res?.usersUpdated || 0;
        onSaved(n ? `"${body.name}" saved. ${n} ${n === 1 ? "person has" : "people have"} the new access now.` : `"${body.name}" saved.`);
      } else {
        await apiClient.createAccessRole(body);
        onSaved(`Role "${body.name}" created. Give it to people from the Users tab or when inviting.`);
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the role.");
    } finally {
      setSaving(false);
    }
  };

  const title = readOnly && role ? role.name : role ? `Edit ${role.name}` : copyOf ? "Duplicate role" : "New role";
  const subtitle = readOnly
    ? "View only. This role includes access you don't hold, so only the admin can change it."
    : "Choose which parts of Terralabs ERP this role opens and what it can do in each.";

  return (
    <EditorSheet
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      wide
      onSubmit={submit}
      title={
        <span className="inline-flex items-center gap-2">
          {readOnly && <Lock className="h-4 w-4 text-muted-foreground" />}
          {title}
        </span>
      }
      description={subtitle}
      footer={
        readOnly ? (
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <>
            {error && <p role="alert" className="text-sm text-destructive-strong sm:mr-auto">{error}</p>}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              {role ? "Save changes" : "Create role"}
            </Button>
          </>
        )
      }
    >
      {!readOnly && role && role.userCount > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-info/25 bg-info-soft px-3 py-2.5 text-sm text-info-strong">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          {role.userCount} {role.userCount === 1 ? "person has" : "people have"} this role. Saving changes their access straight away.
        </p>
      )}

      <EditorSection title="Details">
        <div className="space-y-1.5">
          <Label htmlFor="role-name">Role name</Label>
          <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Press operator" maxLength={60} disabled={readOnly} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role-desc">Description {!readOnly && <span className="font-normal text-muted-foreground">(optional)</span>}</Label>
          <Textarea id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={300} placeholder="What people with this role do" disabled={readOnly} />
        </div>
      </EditorSection>

      <EditorSection title="Account type" description="Decides whose records people with this role can see.">
        <div role="radiogroup" aria-label="Account type" className="grid overflow-hidden rounded-lg border sm:grid-cols-3 sm:divide-x">
          {(Object.keys(BASE_ROLES) as BaseRole[]).map((k, i) => {
            const active = baseRole === k;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={readOnly}
                onClick={() => setBaseRole(k)}
                className={cn(
                  "flex items-start gap-2.5 px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  i > 0 && "border-t sm:border-t-0",
                  active ? "bg-primary-soft/50" : "hover:bg-muted/40",
                  readOnly && "cursor-default hover:bg-transparent"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    active ? "border-primary" : "border-muted-foreground/40"
                  )}
                  aria-hidden
                >
                  {active && <span className="h-2 w-2 rounded-full bg-primary" />}
                </span>
                <span>
                  <span className="block text-sm font-medium">{BASE_ROLES[k].label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{BASE_ROLES[k].description}</span>
                </span>
              </button>
            );
          })}
        </div>
        {VIEW_ALL_ROLES.includes(baseRole) && (
          <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-3">
            <label htmlFor="role-viewall" className={cn("min-w-0", canGrantViewAll && !readOnly && "cursor-pointer")}>
              <span className="block text-sm font-medium">Can view all staff data</span>
              <span className="block text-xs text-muted-foreground">
                See invoices, tasks and other records created by everyone, and the team overview (with Staff & Tasks).
                {!canGrantViewAll && !readOnly && " Only the admin can turn this on."}
              </span>
            </label>
            <Switch id="role-viewall" checked={viewAll} onCheckedChange={setViewAll} disabled={readOnly || !canGrantViewAll} />
          </div>
        )}
      </EditorSection>

      <EditorSection
        title="Permissions"
        description={readOnly ? "What this role opens." : "Turn on a section, then tick the actions inside it. Locked items are ones you don't hold yourself."}
      >
        <PermissionMatrix value={permissions} onChange={setPermissions} canGrant={hasPermission} readOnly={readOnly} />
      </EditorSection>
    </EditorSheet>
  );
}
