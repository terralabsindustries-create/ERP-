import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, Plus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { MetricBar } from "@/components/data";
import { UsersTab } from "@/components/users/UsersTab";
import { RolesTab } from "@/components/users/RolesTab";
import { TeamsTab } from "@/components/users/TeamsTab";
import { UserSheet } from "@/components/users/UserSheet";
import { RoleSheet } from "@/components/users/RoleSheet";
import { TeamSheet } from "@/components/users/TeamSheet";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { NO_FILTERS, userState, type AccessRoleRecord, type ManagedUser, type TeamRecord, type UserFilters } from "@/lib/userAdmin";

type Tab = "users" | "roles" | "teams";
type Confirm =
  | { kind: "user"; user: ManagedUser }
  | { kind: "role"; role: AccessRoleRecord }
  | { kind: "team"; team: TeamRecord };

interface Seats {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Users, roles and teams in one place: invite people and give each a role,
 * build roles from the permission catalogue, and group people into teams.
 * The API enforces every rule shown here (routes/users.js, accessRoles.js,
 * teams.js); the screen only mirrors it.
 */
export default function UserManagement() {
  const { user: me, hasPermission } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (["users", "roles", "teams"].includes(params.get("tab") || "") ? params.get("tab") : "users") as Tab;

  const canInvite = hasPermission("User Management: Create Login");
  const canEdit = hasPermission("User Management: Edit Permissions");
  const canDelete = me?.role === "admin";
  const canSeeOverview = hasPermission("Staff & Tasks") && (me?.role === "admin" || me?.canViewAllData === true);

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roles, setRoles] = useState<AccessRoleRecord[]>([]);
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [seats, setSeats] = useState<Seats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<UserFilters>({ q: "", role: params.get("role") || "all", team: params.get("team") || "all", status: "all" });

  const [userSheet, setUserSheet] = useState<{ open: boolean; user: ManagedUser | null }>({ open: false, user: null });
  const [roleSheet, setRoleSheet] = useState<{ open: boolean; role: AccessRoleRecord | null; copyOf: AccessRoleRecord | null; readOnly?: boolean }>({ open: false, role: null, copyOf: null });
  const [teamSheet, setTeamSheet] = useState<{ open: boolean; team: TeamRecord | null }>({ open: false, team: null });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, r, t, s] = await Promise.all([
        apiClient.getUsers({ limit: 100 }) as Promise<{ users?: ManagedUser[] }>,
        apiClient.getAccessRoles() as Promise<{ roles: AccessRoleRecord[] }>,
        apiClient.getTeams() as Promise<{ teams: TeamRecord[] }>,
        (apiClient.getUserStats() as Promise<{ stats?: { staffSeats?: Seats } }>).catch(() => null)
      ]);
      setUsers((u?.users || []).map((x) => ({ ...x, teams: x.teams || [], permissions: x.permissions || [] })));
      setRoles(r.roles || []);
      setTeams(t.teams || []);
      setSeats(s?.stats?.staffSeats || null);
    } catch (error) {
      toast({ title: "User management could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const setTab = (next: Tab, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (next !== "users") p.set("tab", next);
    Object.entries(extra).forEach(([k, v]) => p.set(k, v));
    setParams(p, { replace: true });
  };

  const done = (message: string) => {
    toast({ title: message });
    load();
  };
  const failed = (title: string, error: unknown) =>
    toast({ title, description: error instanceof Error ? error.message : undefined, variant: "destructive" });

  // Mirrors utils/userAccess.js manageableBy: never the owner, and for anyone
  // but the admin, only people who hold nothing the editor lacks.
  const canManage = useCallback(
    (u: ManagedUser) => {
      if (u.role === "admin") return false;
      if (me?.role === "admin") return true;
      if (u.canViewAllData && !me?.canViewAllData) return false;
      return u.permissions.every((p) => p === "Dashboard" || hasPermission(p));
    },
    [me, hasPermission]
  );

  const seatsFull = !!seats && seats.remaining <= 0;
  const states = users.map(userState);
  const activeCount = states.filter((x) => x === "active" || x === "owner").length;
  const inactiveCount = states.filter((x) => x === "inactive").length;
  const invitedCount = states.filter((x) => x === "invited").length;
  const customCount = users.filter((u) => u.role !== "admin" && !u.accessRole).length;

  const showUsers = (f: UserFilters) => {
    setFilters(f);
    setTab("users");
  };

  const resend = async (u: ManagedUser) => {
    try {
      await apiClient.resendInvitation(u._id);
      done(`A new invitation was sent to ${u.email}.`);
    } catch (e) {
      failed("Invitation not sent", e);
    }
  };

  const toggleActive = async (u: ManagedUser) => {
    try {
      await apiClient.toggleUserStatus(u._id);
      done(u.isActive === false ? `${u.fullName} can sign in again.` : `${u.fullName} can no longer sign in. Their records stay.`);
    } catch (e) {
      failed("Status not changed", e);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "user") {
        await apiClient.deleteUser(confirm.user._id);
        done(confirm.user.status === "invited" ? `Invitation to ${confirm.user.email} cancelled.` : `${confirm.user.fullName}'s login was removed.`);
      } else if (confirm.kind === "role") {
        await apiClient.deleteAccessRole(confirm.role._id);
        done(`Role "${confirm.role.name}" deleted.`);
      } else {
        await apiClient.deleteTeam(confirm.team._id);
        done(`Team "${confirm.team.name}" deleted. Its people keep their logins and roles.`);
      }
      setConfirm(null);
    } catch (e) {
      failed("Not deleted", e);
    } finally {
      setBusy(false);
    }
  };

  const headerAction =
    tab === "users" ? (
      canInvite && (
        <Button onClick={() => setUserSheet({ open: true, user: null })} disabled={seatsFull} title={seatsFull ? "Every login seat is in use" : undefined}>
          <UserPlus />
          Invite user
        </Button>
      )
    ) : tab === "roles" ? (
      canEdit && (
        <Button onClick={() => setRoleSheet({ open: true, role: null, copyOf: null })}>
          <Plus />
          New role
        </Button>
      )
    ) : (
      canEdit && (
        <Button onClick={() => setTeamSheet({ open: true, team: null })}>
          <Plus />
          New team
        </Button>
      )
    );

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="Setup"
        title="Users & roles"
        description="Manage who can sign in, what each person can open, and how your team is grouped."
        actions={headerAction}
      />

      <MetricBar
        loading={loading}
        metrics={[
          { label: "Active users", value: activeCount, hint: `${inactiveCount} deactivated`, tone: "success", onClick: () => showUsers({ ...NO_FILTERS, status: "active" }) },
          {
            label: "Pending invitations",
            value: invitedCount,
            hint: invitedCount ? "Waiting for a password" : "None waiting",
            tone: invitedCount ? "warning" : "default",
            onClick: () => showUsers({ ...NO_FILTERS, status: "invited" })
          },
          { label: "Roles", value: roles.length + 1, hint: `${customCount} on custom access`, onClick: () => setTab("roles") },
          {
            label: "Login seats",
            value: seats ? `${seats.used} / ${seats.limit}` : "—",
            hint: seats ? (seatsFull ? "All seats in use" : `${seats.remaining} available`) : undefined,
            tone: seatsFull ? "danger" : "default"
          }
        ]}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        {/* Page-level tabs: an underlined row, like a settings console. */}
        <TabsList className="h-auto w-full gap-6 rounded-none border-0 border-b bg-transparent p-0">
          {(
            [
              ["users", "Users", users.length],
              ["roles", "Roles", roles.length + 1],
              ["teams", "Teams", teams.length]
            ] as const
          ).map(([value, label, count]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="relative h-10 rounded-none px-0.5 text-sm text-muted-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:bg-primary dark:data-[state=active]:bg-transparent"
            >
              {label}
              {!loading && <span className="num rounded-full bg-muted px-1.5 py-px text-[11px] font-semibold text-muted-foreground">{count}</span>}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="users" className="mt-5">
          <UsersTab
            users={users}
            roles={roles}
            teams={teams}
            loading={loading}
            filters={filters}
            onFiltersChange={setFilters}
            meId={me?.id}
            canInvite={canInvite && !seatsFull}
            canEdit={canEdit}
            canDelete={canDelete}
            canManage={canManage}
            onInvite={() => setUserSheet({ open: true, user: null })}
            onEdit={(u) => setUserSheet({ open: true, user: u })}
            onResend={resend}
            onToggleActive={toggleActive}
            onDelete={(u) => setConfirm({ kind: "user", user: u })}
          />
        </TabsContent>

        <TabsContent value="roles" className="mt-5">
          <RolesTab
            roles={roles}
            users={users}
            loading={loading}
            canEdit={canEdit}
            onOpen={(r) => setRoleSheet({ open: true, role: r, copyOf: null, readOnly: !(canEdit && r.editable) })}
            onDuplicate={(r) => setRoleSheet({ open: true, role: null, copyOf: r })}
            onDelete={(r) => setConfirm({ kind: "role", role: r })}
            onShowPeople={(role) => showUsers({ ...NO_FILTERS, role })}
          />
        </TabsContent>

        <TabsContent value="teams" className="mt-5">
          <TeamsTab
            teams={teams}
            loading={loading}
            canEdit={canEdit}
            canSeeOverview={canSeeOverview}
            onCreate={() => setTeamSheet({ open: true, team: null })}
            onEdit={(t) => setTeamSheet({ open: true, team: t })}
            onDelete={(t) => setConfirm({ kind: "team", team: t })}
          />
        </TabsContent>
      </Tabs>

      <UserSheet
        open={userSheet.open}
        onOpenChange={(open) => setUserSheet((s) => ({ ...s, open }))}
        user={userSheet.user}
        roles={roles}
        teams={teams}
        onSaved={done}
      />
      <RoleSheet
        open={roleSheet.open}
        onOpenChange={(open) => setRoleSheet((s) => ({ ...s, open }))}
        role={roleSheet.role}
        copyOf={roleSheet.copyOf}
        readOnly={roleSheet.readOnly}
        onSaved={done}
      />
      <TeamSheet
        open={teamSheet.open}
        onOpenChange={(open) => setTeamSheet((s) => ({ ...s, open }))}
        team={teamSheet.team}
        people={users}
        onSaved={done}
      />

      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && !busy && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "user"
                ? confirm.user.status === "invited"
                  ? "Cancel this invitation?"
                  : `Remove ${confirm.user.fullName}'s login?`
                : confirm?.kind === "role"
                  ? `Delete the role "${confirm.role.name}"?`
                  : `Delete the team "${confirm?.kind === "team" ? confirm.team.name : ""}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "user"
                ? confirm.user.status === "invited"
                  ? `The link sent to ${confirm.user.email} stops working and the seat is freed.`
                  : `${confirm.user.email} will no longer be able to sign in and the seat is freed. Their HR record is kept as inactive history. This can't be undone; to pause access instead, deactivate them.`
                : confirm?.kind === "role"
                  ? "Nobody has this role, so no one's access changes."
                  : "The people in it keep their logins and roles; only the grouping goes."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                runConfirm();
              }}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy && <Loader2 className="animate-spin" />}
              {confirm?.kind === "user" && confirm.user.status === "invited" ? "Cancel invitation" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
