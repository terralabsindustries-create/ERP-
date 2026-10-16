import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Users } from "lucide-react";
import { Panel, PanelLink } from "@/components/common/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import apiClient from "@/lib/apiClient";
import { cn } from "@/lib/utils";

interface Member {
  user: { _id: string; fullName: string; role: string };
  tasks: { open: number; overdue: number; onHold: number; completed: number; onTime: number; late: number };
}

/**
 * Dashboard summary of who is carrying what. Counts come from
 * GET /api/team/overview; the Team overview page shows the records behind them.
 */
export function TeamWorkloadPanel() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [blocked, setBlocked] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiClient
      .getTeamOverview(30)
      .then((result) => {
        const data = result as { members: Member[]; blocked: unknown[] };
        setMembers(data.members.filter((m) => m.user.role !== "admin" || m.tasks.open || m.tasks.completed));
        setBlocked(data.blocked.length);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;

  const rows = (members || [])
    .slice()
    .sort((a, b) => b.tasks.overdue - a.tasks.overdue || b.tasks.open - a.tasks.open)
    .slice(0, 6);

  return (
    <Panel
      title="Team workload"
      icon={Users}
      description={blocked ? `${blocked} task${blocked === 1 ? "" : "s"} on hold · last 30 days` : "Open work and tasks completed in the last 30 days"}
      action={<PanelLink to="/team">Team overview</PanelLink>}
    >
      {!members ? (
        <div className="space-y-2 p-4 sm:p-5">{[0, 1, 2].map((i) => <div key={i} className="h-8 animate-pulse rounded bg-muted" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState compact icon={Users} title="No team members yet" description="Invite staff from User Management to assign them work." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/60 text-left">
                <th className="px-4 py-2 sm:px-5">Person</th>
                <th className="px-3 py-2 text-right">Open</th>
                <th className="px-3 py-2 text-right">Overdue</th>
                <th className="px-3 py-2 text-right">On hold</th>
                <th className="px-4 py-2 text-right sm:px-5">Done (on time / late)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.user._id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2.5 sm:px-5">
                    <Link to="/team" className="font-medium hover:underline">{m.user.fullName}</Link>
                    <span className="ml-1.5 text-xs capitalize text-muted-foreground">{m.user.role}</span>
                  </td>
                  <td className="num px-3 py-2.5 text-right">{m.tasks.open}</td>
                  <td className={cn("num px-3 py-2.5 text-right", m.tasks.overdue > 0 && "font-semibold text-destructive-strong")}>{m.tasks.overdue}</td>
                  <td className={cn("num px-3 py-2.5 text-right", m.tasks.onHold > 0 && "text-warning-strong")}>{m.tasks.onHold}</td>
                  <td className="num whitespace-nowrap px-4 py-2.5 text-right sm:px-5">
                    {m.tasks.completed}
                    {m.tasks.completed > 0 && (
                      <span className="text-xs text-muted-foreground"> ({m.tasks.onTime} / {m.tasks.late})</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
