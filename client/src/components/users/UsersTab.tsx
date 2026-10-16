import { useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { MoreHorizontal, Pencil, Power, RotateCw, Search, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/common/EmptyState";
import { BASE_ROLES, NO_FILTERS, userState, type AccessRoleRecord, type BaseRole, type ManagedUser, type TeamRecord, type UserFilters } from "@/lib/userAdmin";
import { cn } from "@/lib/utils";
import { DataCard, StatusIndicator, UserAvatar } from "./parts";

interface UsersTabProps {
  users: ManagedUser[];
  roles: AccessRoleRecord[];
  teams: TeamRecord[];
  loading: boolean;
  filters: UserFilters;
  onFiltersChange: (f: UserFilters) => void;
  meId?: string;
  canInvite: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Whether the signed-in login may change this person (see utils/userAccess.js). */
  canManage: (u: ManagedUser) => boolean;
  onInvite: () => void;
  onEdit: (u: ManagedUser) => void;
  onResend: (u: ManagedUser) => void;
  onToggleActive: (u: ManagedUser) => void;
  onDelete: (u: ManagedUser) => void;
}

const lastActive = (u: ManagedUser) =>
  u.lastLogin ? formatDistanceToNow(new Date(u.lastLogin), { addSuffix: true }) : u.status === "invited" ? "Not joined yet" : "Never";

function RoleCell({ u }: { u: ManagedUser }) {
  if (u.role === "admin") {
    return (
      <div>
        <div className="inline-flex items-center gap-1.5 font-medium">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          Owner
        </div>
        <div className="text-xs text-muted-foreground">Full access</div>
      </div>
    );
  }
  const type = BASE_ROLES[u.role as BaseRole]?.label || u.role;
  return (
    <div>
      <div className="font-medium">{u.accessRoleName || "Custom access"}</div>
      <div className="text-xs text-muted-foreground">
        {type}
        {!u.accessRoleName && ` · ${u.permissions.filter((p) => !p.includes(": ") && p !== "Dashboard").length} sections`}
        {u.canViewAllData && " · all records"}
      </div>
    </div>
  );
}

function TeamChips({ u, max = 2 }: { u: ManagedUser; max?: number }) {
  if (!u.teams.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1" title={u.teams.map((t) => t.name).join(", ")}>
      {u.teams.slice(0, max).map((t) => (
        <span key={t._id} className="rounded-md border bg-muted/40 px-1.5 py-0.5 text-xs">{t.name}</span>
      ))}
      {u.teams.length > max && <span className="px-1 py-0.5 text-xs text-muted-foreground">+{u.teams.length - max}</span>}
    </div>
  );
}

/** Everyone with a login in this business, with their role, teams and status. */
export function UsersTab(props: UsersTabProps) {
  const { users, roles, teams, loading, filters, onFiltersChange, meId, canInvite, canEdit, canDelete, canManage } = props;
  const set = (patch: Partial<UserFilters>) => onFiltersChange({ ...filters, ...patch });

  const shown = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return users
      .filter((u) => !q || u.fullName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .filter((u) => {
        if (filters.role === "all") return true;
        if (filters.role === "owner") return u.role === "admin";
        if (filters.role === "custom") return u.role !== "admin" && !u.accessRole;
        return u.accessRole === filters.role;
      })
      .filter((u) => filters.team === "all" || u.teams.some((t) => t._id === filters.team))
      .filter((u) => {
        if (filters.status === "all") return true;
        const s = userState(u);
        return filters.status === "active" ? s === "active" || s === "owner" : s === filters.status;
      })
      // Owner first, then by name.
      .sort((a, b) => Number(b.role === "admin") - Number(a.role === "admin") || a.fullName.localeCompare(b.fullName));
  }, [users, filters]);

  const filtered = filters.q || filters.role !== "all" || filters.team !== "all" || filters.status !== "all";

  const actions = (u: ManagedUser) => {
    if (u.role === "admin" || u._id === meId) return null;
    const state = userState(u);
    const manageable = canManage(u);
    const items = [
      canEdit && (
        <DropdownMenuItem key="edit" disabled={!manageable} onClick={() => props.onEdit(u)}>
          <Pencil />
          {manageable ? "Edit user" : "Has access you don't hold"}
        </DropdownMenuItem>
      ),
      canInvite && state === "invited" && (
        <DropdownMenuItem key="resend" onClick={() => props.onResend(u)}>
          <RotateCw />
          Resend invitation
        </DropdownMenuItem>
      ),
      canEdit && manageable && state !== "invited" && (
        <DropdownMenuItem key="toggle" onClick={() => props.onToggleActive(u)}>
          <Power />
          {state === "inactive" ? "Reactivate" : "Deactivate"}
        </DropdownMenuItem>
      ),
      canDelete && <DropdownMenuSeparator key="sep" />,
      canDelete && (
        <DropdownMenuItem key="delete" className="text-destructive-strong focus:text-destructive-strong" onClick={() => props.onDelete(u)}>
          <Trash2 />
          {state === "invited" ? "Cancel invitation" : "Delete user"}
        </DropdownMenuItem>
      )
    ].filter(Boolean);
    if (!items.length) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.fullName}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">{items}</DropdownMenuContent>
      </DropdownMenu>
    );
  };

  // A row opens the editor when the person can be managed.
  const openable = (u: ManagedUser) => canEdit && u.role !== "admin" && u._id !== meId && canManage(u);

  const toolbar = (
    <>
      <div className="relative w-full sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Search by name or email" className="h-9 pl-8" aria-label="Search people" />
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0 [&>button]:min-w-[140px] sm:[&>button]:min-w-0">
        <Select value={filters.role} onValueChange={(role) => set({ role })}>
          <SelectTrigger className="h-9 sm:w-[160px]" aria-label="Filter by role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            <SelectSeparator />
            <SelectItem value="owner">Owner</SelectItem>
            {roles.map((r) => (
              <SelectItem key={r._id} value={r._id}>{r.name}</SelectItem>
            ))}
            <SelectItem value="custom">Custom access</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.team} onValueChange={(team) => set({ team })}>
          <SelectTrigger className="h-9 sm:w-[150px]" aria-label="Filter by team">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All teams</SelectItem>
            {teams.length > 0 && <SelectSeparator />}
            {teams.map((t) => (
              <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={(status) => set({ status })}>
          <SelectTrigger className="h-9 sm:w-[140px]" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            <SelectSeparator />
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="invited">Invited</SelectItem>
            <SelectItem value="inactive">Deactivated</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  );

  const footer = !loading && shown.length > 0 && (
    <div className="flex items-center justify-between gap-2">
      <span>
        {filtered ? `${shown.length} of ${users.length}` : users.length} {users.length === 1 ? "person" : "people"}
      </span>
      {filtered && (
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => onFiltersChange(NO_FILTERS)}>
          Clear filters
        </button>
      )}
    </div>
  );

  return (
    <DataCard toolbar={toolbar} footer={footer}>
      {loading ? (
        <div className="divide-y">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3.5">
              <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
              <div className="h-4 w-48 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        filtered ? (
          <EmptyState compact icon={Search} title="No one matches these filters" action={<Button variant="outline" size="sm" onClick={() => onFiltersChange(NO_FILTERS)}>Clear filters</Button>} />
        ) : (
          <EmptyState
            icon={Users}
            title="It's just you so far"
            description="Invite your designers, press operators and accounts team, and give each of them a role."
            action={canInvite && <Button onClick={props.onInvite}><UserPlus />Invite user</Button>}
          />
        )
      ) : (
        <>
          {/* Phones: one row per person */}
          <ul className="divide-y md:hidden">
            {shown.map((u) => (
              <li key={u._id} className="flex items-start gap-3 px-4 py-3">
                <UserAvatar name={u.fullName} owner={u.role === "admin"} />
                <div className="min-w-0 flex-1 space-y-2">
                  <div>
                    <div className="truncate text-sm font-medium">{u.fullName}{u._id === meId && <span className="font-normal text-muted-foreground"> (you)</span>}</div>
                    <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                  </div>
                  <div className="text-sm"><RoleCell u={u} /></div>
                  {u.teams.length > 0 && <TeamChips u={u} max={3} />}
                  <StatusIndicator state={userState(u)} expiresAt={u.invitation?.expiresAt} />
                </div>
                {actions(u)}
              </li>
            ))}
          </ul>

          {/* Wider screens: a table */}
          <table className="hidden w-full text-sm md:table">
            <thead>
              <tr className="border-b text-left">
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Teams</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Last active</th>
                <th className="w-12 px-2 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((u) => {
                const state = userState(u);
                const canOpen = openable(u);
                return (
                  <tr
                    key={u._id}
                    onClick={canOpen ? () => props.onEdit(u) : undefined}
                    className={cn("transition-colors", canOpen && "cursor-pointer hover:bg-muted/40")}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <UserAvatar name={u.fullName} owner={u.role === "admin"} className={cn(state === "inactive" && "opacity-50")} />
                        <div className="min-w-0">
                          <div className={cn("truncate font-medium", state === "inactive" && "text-muted-foreground")}>
                            {u.fullName}
                            {u._id === meId && <span className="font-normal text-muted-foreground"> (you)</span>}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><RoleCell u={u} /></td>
                    <td className="px-4 py-3"><TeamChips u={u} /></td>
                    <td className="px-4 py-3"><StatusIndicator state={state} expiresAt={u.invitation?.expiresAt} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{lastActive(u)}</td>
                    {/* The menu handles its own clicks; don't also open the row. */}
                    <td className="px-2 py-3 text-right" onClick={(e) => e.stopPropagation()}>{actions(u)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </DataCard>
  );
}
