import { format } from "date-fns";
import { Copy, Eye, Lock, MoreHorizontal, Pencil, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BASE_ROLES, grantedModules, moduleLabel, type AccessRoleRecord, type ManagedUser } from "@/lib/userAdmin";
import { AvatarStack, DataCard } from "./parts";

interface RolesTabProps {
  roles: AccessRoleRecord[];
  users: ManagedUser[];
  loading: boolean;
  canEdit: boolean;
  onOpen: (r: AccessRoleRecord) => void;
  onDuplicate: (r: AccessRoleRecord) => void;
  onDelete: (r: AccessRoleRecord) => void;
  /** Show the people with this role (or "owner" / "custom") on the Users tab. */
  onShowPeople: (roleFilter: string) => void;
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** Every role in the business: what it opens and who has it. */
export function RolesTab({ roles, users, loading, canEdit, onOpen, onDuplicate, onDelete, onShowPeople }: RolesTabProps) {
  const holders = (filter: (u: ManagedUser) => boolean) => users.filter(filter).map((u) => u.fullName);
  const owners = holders((u) => u.role === "admin");
  const custom = holders((u) => u.role !== "admin" && !u.accessRole);

  const members = (names: string[], filter: string) =>
    names.length ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onShowPeople(filter);
        }}
        className="flex items-center gap-2 rounded-md text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Show the ${people(names.length)} with this role`}
      >
        <AvatarStack names={names} max={3} />
        <span className="text-xs text-muted-foreground">{names.length}</span>
      </button>
    ) : (
      <span className="whitespace-nowrap text-xs text-muted-foreground">No one yet</span>
    );

  return (
    <DataCard
      toolbar={
        <p className="text-sm text-muted-foreground">
          A role is a saved set of permissions. Editing a role changes access for everyone who has it.
        </p>
      }
      footer={!loading && `${roles.length + 1} roles · ${people(custom.length)} on custom access`}
    >
      {loading ? (
        <div className="divide-y">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="px-4 py-4"><div className="h-4 w-64 animate-pulse rounded bg-muted" /></div>
          ))}
        </div>
      ) : (
        <>
          <ul className="divide-y md:hidden">
            <li className="flex items-start gap-3 bg-primary-soft/25 px-4 py-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">Owner</div>
                <div className="text-xs text-muted-foreground">Admin · full access · built in</div>
              </div>
              {members(owners, "owner")}
            </li>
            {roles.map((r) => {
              const mods = grantedModules(r.permissions);
              return (
                <li key={r._id}>
                  <button type="button" onClick={() => onOpen(r)} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/40">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 font-medium">
                        {r.name}
                        {!r.editable && <Lock className="h-3 w-3 text-muted-foreground" />}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {BASE_ROLES[r.baseRole]?.label} · {r.canViewAllData ? "all records" : "own records"} · {mods.length} sections
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{people(r.userCount)}</span>
                  </button>
                </li>
              );
            })}
            <li className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">Custom access</div>
                <div className="text-xs text-muted-foreground">Permissions set per person</div>
              </div>
              {members(custom, "custom")}
            </li>
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-4 py-2.5">Role</th>
                  <th className="px-4 py-2.5">Account type</th>
                  <th className="px-4 py-2.5">Access</th>
                  <th className="px-4 py-2.5">Members</th>
                  <th className="px-4 py-2.5">Updated</th>
                  <th className="w-12 px-2 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr className="bg-primary-soft/25">
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        <ShieldCheck className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="font-medium">Owner</div>
                        <div className="text-xs text-muted-foreground">The account that signed the business up. Can't be changed.</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">Admin</td>
                  <td className="px-4 py-3">
                    <div>Full access</div>
                    <div className="text-xs text-muted-foreground">Every section and action</div>
                  </td>
                  <td className="px-4 py-3">{members(owners, "owner")}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <span className="inline-flex items-center gap-1 text-xs"><Lock className="h-3 w-3" />Built in</span>
                  </td>
                  <td className="px-2 py-3" />
                </tr>

                {roles.map((r) => {
                  const mods = grantedModules(r.permissions);
                  const actions = r.permissions.filter((p) => p.includes(": ")).length;
                  const names = holders((u) => u.accessRole === r._id);
                  return (
                    <tr key={r._id} onClick={() => onOpen(r)} className="cursor-pointer transition-colors hover:bg-muted/40">
                      <td className="max-w-[340px] px-4 py-3">
                        <div className="flex items-center gap-1.5 font-medium">
                          {r.name}
                          {!r.editable && <Lock className="h-3 w-3 text-muted-foreground" aria-label="Includes access you don't hold" />}
                        </div>
                        {r.description && <div className="line-clamp-1 text-xs text-muted-foreground" title={r.description}>{r.description}</div>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div>{BASE_ROLES[r.baseRole]?.label || r.baseRole}</div>
                        <div className="text-xs text-muted-foreground">{r.canViewAllData ? "All records" : "Own records"}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="whitespace-nowrap">{mods.length} sections · {actions} actions</div>
                        <div className="max-w-[260px] truncate text-xs text-muted-foreground" title={mods.map(moduleLabel).join(", ")}>
                          {mods.length ? mods.map(moduleLabel).join(", ") : "Dashboard only"}
                        </div>
                      </td>
                      <td className="px-4 py-3">{members(names, r._id)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{r.updatedAt ? format(new Date(r.updatedAt), "d MMM yyyy") : "—"}</td>
                      <td className="px-2 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            {canEdit && r.editable ? (
                              <DropdownMenuItem onClick={() => onOpen(r)}>
                                <Pencil />
                                Edit role
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => onOpen(r)}>
                                <Eye />
                                View permissions
                              </DropdownMenuItem>
                            )}
                            {canEdit && (
                              <DropdownMenuItem onClick={() => onDuplicate(r)}>
                                <Copy />
                                Duplicate
                              </DropdownMenuItem>
                            )}
                            {canEdit && <DropdownMenuSeparator />}
                            {canEdit && (
                              <DropdownMenuItem
                                disabled={!r.editable || r.userCount > 0}
                                className="text-destructive-strong focus:text-destructive-strong"
                                onClick={() => onDelete(r)}
                              >
                                <Trash2 />
                                {r.userCount > 0 ? "In use — can't delete" : "Delete role"}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}

                <tr className="text-muted-foreground">
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-dashed">
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0">
                        <div className="font-medium text-foreground">Custom access</div>
                        <div className="text-xs">Permissions picked one by one for a person. Give them a role to manage them together.</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">Varies</td>
                  <td className="px-4 py-3">Per person</td>
                  <td className="px-4 py-3">{members(custom, "custom")}</td>
                  <td className="px-4 py-3" />
                  <td className="px-2 py-3" />
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </DataCard>
  );
}
