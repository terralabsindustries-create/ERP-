import { useNavigate } from "react-router-dom";
import { BarChart3, MoreHorizontal, Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/common/EmptyState";
import type { TeamRecord } from "@/lib/userAdmin";
import { cn } from "@/lib/utils";
import { AvatarStack, DataCard, UserAvatar } from "./parts";

interface TeamsTabProps {
  teams: TeamRecord[];
  loading: boolean;
  canEdit: boolean;
  /** Link each team to its slice of the team overview. */
  canSeeOverview: boolean;
  onCreate: () => void;
  onEdit: (t: TeamRecord) => void;
  onDelete: (t: TeamRecord) => void;
}

/** Groups of people, e.g. Pre-press or Finishing, with their lead and members. */
export function TeamsTab({ teams, loading, canEdit, canSeeOverview, onCreate, onEdit, onDelete }: TeamsTabProps) {
  const navigate = useNavigate();

  return (
    <DataCard
      toolbar={<p className="text-sm text-muted-foreground">Teams group people who work together. They don't change what anyone can access.</p>}
      footer={!loading && teams.length > 0 && `${teams.length} ${teams.length === 1 ? "team" : "teams"}`}
    >
      {loading ? (
        <div className="divide-y">
          {[0, 1, 2].map((i) => (
            <div key={i} className="px-4 py-4"><div className="h-4 w-56 animate-pulse rounded bg-muted" /></div>
          ))}
        </div>
      ) : teams.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No teams yet"
          description="Create teams like Pre-press, Press, Finishing or Accounts, then filter the user list and team overview by team."
          action={canEdit && <Button onClick={onCreate}><Plus />New team</Button>}
        />
      ) : (
        <>
          <ul className="divide-y md:hidden">
            {teams.map((t) => (
              <li key={t._id}>
                <button type="button" disabled={!canEdit} onClick={() => onEdit(t)} className="flex w-full items-center gap-3 px-4 py-3 text-left enabled:hover:bg-muted/40">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{t.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t.lead ? `Lead: ${t.lead.fullName}` : "No lead"}
                      {t.description ? ` · ${t.description}` : ""}
                    </div>
                  </div>
                  <AvatarStack names={t.members.map((m) => m.fullName)} max={3} />
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-4 py-2.5">Team</th>
                  <th className="px-4 py-2.5">Lead</th>
                  <th className="px-4 py-2.5">Members</th>
                  <th className="w-12 px-2 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {teams.map((t) => (
                  <tr key={t._id} onClick={canEdit ? () => onEdit(t) : undefined} className={cn("transition-colors", canEdit && "cursor-pointer hover:bg-muted/40")}>
                    <td className="max-w-[360px] px-4 py-3">
                      <div className="font-medium">{t.name}</div>
                      {t.description && <div className="line-clamp-1 text-xs text-muted-foreground" title={t.description}>{t.description}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {t.lead ? (
                        <span className="inline-flex items-center gap-2">
                          <UserAvatar name={t.lead.fullName} size="xs" />
                          {t.lead.fullName}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <AvatarStack names={t.members.map((m) => m.fullName)} max={4} />
                        {t.members.length > 0 && <span className="text-xs text-muted-foreground">{t.members.length}</span>}
                      </span>
                    </td>
                    <td className="px-2 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      {(canEdit || canSeeOverview) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            {canSeeOverview && t.members.length > 0 && (
                              <DropdownMenuItem onClick={() => navigate(`/team?team=${t._id}`)}>
                                <BarChart3 />
                                Open team overview
                              </DropdownMenuItem>
                            )}
                            {canEdit && (
                              <DropdownMenuItem onClick={() => onEdit(t)}>
                                <Pencil />
                                Edit team
                              </DropdownMenuItem>
                            )}
                            {canEdit && <DropdownMenuSeparator />}
                            {canEdit && (
                              <DropdownMenuItem className="text-destructive-strong focus:text-destructive-strong" onClick={() => onDelete(t)}>
                                <Trash2 />
                                Delete team
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </DataCard>
  );
}
