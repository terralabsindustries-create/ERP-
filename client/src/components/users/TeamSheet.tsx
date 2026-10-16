import { useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import apiClient from "@/lib/apiClient";
import type { ManagedUser, TeamRecord } from "@/lib/userAdmin";
import { EditorSection, EditorSheet } from "./EditorSheet";
import { UserAvatar } from "./parts";

const NO_LEAD = "none";

interface TeamSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: TeamRecord | null;
  people: ManagedUser[];
  onSaved: (message: string) => void;
}

/** Create or change a team: its name, members and lead. */
export function TeamSheet({ open, onOpenChange, team, people, onSaved }: TeamSheetProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [lead, setLead] = useState(NO_LEAD);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(team?.name || "");
    setDescription(team?.description || "");
    setMembers(team?.members.map((m) => m._id) || []);
    setLead(team?.lead?._id || NO_LEAD);
    setFilter("");
    setError("");
  }, [open, team]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return people
      .filter((p) => !q || p.fullName.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [people, filter]);

  const toggle = (id: string) => {
    const next = members.includes(id) ? members.filter((m) => m !== id) : [...members, id];
    setMembers(next);
    if (!next.includes(lead)) setLead(NO_LEAD);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Give the team a name.");
    setError("");
    setSaving(true);
    const body = { name: name.trim(), description: description.trim(), memberIds: members, leadId: lead === NO_LEAD ? null : lead };
    try {
      if (team) await apiClient.updateTeam(team._id, body);
      else await apiClient.createTeam(body);
      onSaved(team ? `Team "${body.name}" saved.` : `Team "${body.name}" created.`);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the team.");
    } finally {
      setSaving(false);
    }
  };

  const chosen = people.filter((p) => members.includes(p._id));

  return (
    <EditorSheet
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      onSubmit={submit}
      title={team ? `Edit team: ${team.name}` : "New team"}
      description="Group people who work together. Teams don't change what anyone can access."
      footer={
        <>
          {error && <p role="alert" className="text-sm text-destructive-strong sm:mr-auto">{error}</p>}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {team ? "Save team" : "Create team"}
          </Button>
        </>
      }
    >
      <EditorSection title="About this team">
        <div className="space-y-1.5">
          <Label htmlFor="team-name">Name</Label>
          <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Finishing" maxLength={60} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="team-desc">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea id="team-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={300} placeholder="Cutting, binding and lamination" />
        </div>
      </EditorSection>

      <EditorSection title={`Members (${members.length})`}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a person" className="pl-8" aria-label="Find a person" />
        </div>
        <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
          {shown.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted-foreground">No one matches.</li>}
          {shown.map((p) => {
            const id = `team-member-${p._id}`;
            return (
              <li key={p._id}>
                <label htmlFor={id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40">
                  <Checkbox id={id} checked={members.includes(p._id)} onCheckedChange={() => toggle(p._id)} />
                  <UserAvatar name={p.fullName} owner={p.role === "admin"} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.fullName}</span>
                    <span className="block truncate text-xs text-muted-foreground">{p.role === "admin" ? "Owner" : p.accessRoleName || "Custom access"}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </EditorSection>

      <EditorSection title="Team lead" description="Optional. The person others in the team go to first.">
        <Select value={lead} onValueChange={setLead} disabled={chosen.length === 0}>
          <SelectTrigger aria-label="Team lead">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_LEAD}>No lead</SelectItem>
            {chosen.map((p) => (
              <SelectItem key={p._id} value={p._id}>{p.fullName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </EditorSection>
    </EditorSheet>
  );
}
