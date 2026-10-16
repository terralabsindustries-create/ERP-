import { useMemo, useState } from "react";
import { Check, Lock, Search } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { PERMISSION_TREE, actionName, actionsForModule } from "@/lib/permissions";
import { MODULE_INFO, PERMISSION_AREAS } from "@/lib/userAdmin";
import { cn } from "@/lib/utils";

interface PermissionMatrixProps {
  value: string[];
  onChange?: (next: string[]) => void;
  /** Show the grants without letting them change. */
  readOnly?: boolean;
  /**
   * Whether the signed-in login may hand this permission out. The API refuses
   * anything they don't hold themselves, so those controls are locked here.
   */
  canGrant?: (permission: string) => boolean;
  className?: string;
}

const ACTIONS_BY_MODULE = Object.fromEntries(PERMISSION_TREE.map((g) => [g.module, g.actions]));
const slug = (s: string) => s.replace(/\W+/g, "-");

/**
 * Sections of the app (modules) grouped like the sidebar, each with a switch
 * and the actions inside it. Turning a section on also ticks its "View"
 * action; turning it off clears every action beneath it, so a saved list never
 * implies access to a section the person cannot open. Dashboard is always on.
 */
export function PermissionMatrix({ value, onChange, readOnly = false, canGrant = () => true, className }: PermissionMatrixProps) {
  const [filter, setFilter] = useState("");
  const granted = useMemo(() => new Set(value), [value]);
  const set = (next: string[]) => onChange?.([...new Set(next)]);

  const toggleModule = (module: string) => {
    const children = actionsForModule(module);
    if (granted.has(module)) {
      set(value.filter((p) => p !== module && !children.includes(p)));
      return;
    }
    const view = actionName(module, "View");
    set([...value, module, ...(children.includes(view) && canGrant(view) ? [view] : [])]);
  };

  const toggleAction = (perm: string) => set(granted.has(perm) ? value.filter((p) => p !== perm) : [...value, perm]);

  // Every module in an area, with all its actions — or none of them.
  const setArea = (modules: string[], on: boolean) => {
    const all = modules.filter((m) => m !== "Dashboard").flatMap((m) => [m, ...actionsForModule(m)]);
    if (on) set([...value, ...all.filter(canGrant)]);
    else set(value.filter((p) => !all.includes(p) || !canGrant(p)));
  };

  const q = filter.trim().toLowerCase();
  const areas = PERMISSION_AREAS.map((area) => ({
    ...area,
    modules: area.modules.filter((m) => {
      // Read-only views list only what is granted.
      if (readOnly && (m === "Dashboard" || !granted.has(m))) return false;
      if (!q) return true;
      const info = MODULE_INFO[m];
      return [m, info?.label, info?.hint, ...(ACTIONS_BY_MODULE[m] || [])].some((t) => t?.toLowerCase().includes(q));
    })
  })).filter((a) => a.modules.length > 0);

  const moduleCount = PERMISSION_TREE.filter((g) => g.module !== "Dashboard" && granted.has(g.module)).length;
  const actionCount = value.filter((p) => p.includes(": ")).length;

  return (
    <div className={cn("space-y-3", className)}>
      {!readOnly && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            <span className="num font-semibold text-foreground">{moduleCount}</span> sections and{" "}
            <span className="num font-semibold text-foreground">{actionCount}</span> actions selected
          </p>
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter permissions" className="h-9 pl-8" aria-label="Filter permissions" />
          </div>
        </div>
      )}

      {areas.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {readOnly ? "Dashboard only." : `Nothing matches “${filter}”.`}
        </p>
      )}

      <div className={cn("overflow-hidden rounded-lg border", areas.length === 0 && "hidden")}>
        {areas.map((area, ai) => {
          const on = area.modules.filter((m) => granted.has(m)).length;
          const grantable = area.modules.some((m) => m !== "Dashboard" && canGrant(m));
          return (
            <section key={area.label} className={cn(ai > 0 && "border-t")}>
              <header className="flex items-center justify-between gap-2 bg-muted/50 px-3 py-2 sm:px-4">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {area.label}
                  {!readOnly && <span className="ml-2 font-normal normal-case tracking-normal">{on} of {area.modules.length} on</span>}
                </h4>
                {!readOnly && grantable && !q && (
                  <div className="flex items-center gap-1 text-xs">
                    <button type="button" className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary-soft" onClick={() => setArea(area.modules, true)}>
                      Select all
                    </button>
                    <span className="text-border" aria-hidden>|</span>
                    <button type="button" className="rounded px-1.5 py-0.5 font-medium text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setArea(area.modules, false)}>
                      Clear
                    </button>
                  </div>
                )}
              </header>
              <ul className="divide-y border-t">
                {area.modules.map((module) => {
                  const info = MODULE_INFO[module] || { label: module, hint: "" };
                  const actions = ACTIONS_BY_MODULE[module] || [];
                  const isDashboard = module === "Dashboard";
                  const moduleOn = granted.has(module) || isDashboard;
                  const moduleLocked = readOnly || isDashboard || !canGrant(module);
                  const switchId = `perm-${slug(module)}`;
                  const anyAction = actions.some((a) => granted.has(actionName(module, a)));
                  return (
                    <li key={module} className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,15rem)_1fr] sm:items-center sm:gap-4 sm:px-4">
                      <div className="flex min-w-0 items-center gap-3">
                        {!readOnly && (
                          <Switch id={switchId} checked={moduleOn} disabled={moduleLocked} onCheckedChange={() => toggleModule(module)} aria-label={`${info.label} section`} />
                        )}
                        <label htmlFor={readOnly ? undefined : switchId} className={cn("min-w-0", !moduleLocked && "cursor-pointer")}>
                          <span className={cn("flex items-center gap-1.5 text-sm font-medium", !moduleOn && "text-muted-foreground")}>
                            {info.label}
                            {!readOnly && !isDashboard && !canGrant(module) && (
                              <Lock className="h-3 w-3 text-muted-foreground" aria-label="You don't hold this yourself" />
                            )}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">{info.hint}</span>
                        </label>
                      </div>

                      {readOnly ? (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                          {anyAction
                            ? actions
                                .filter((a) => granted.has(actionName(module, a)))
                                .map((a) => (
                                  <span key={a} className="inline-flex items-center gap-1.5">
                                    <Check className="h-3.5 w-3.5 text-success-strong" />
                                    {a}
                                  </span>
                                ))
                            : actions.length > 0 && <span className="text-muted-foreground">Every action (older full-section grant)</span>}
                        </div>
                      ) : (
                        actions.length > 0 && (
                          <div className={cn("flex flex-wrap gap-x-5 gap-y-2 pl-12 sm:pl-0", !moduleOn && "opacity-50")}>
                            {actions.map((action) => {
                              const perm = actionName(module, action);
                              const id = `${switchId}-${slug(action)}`;
                              const locked = !moduleOn || !canGrant(perm);
                              return (
                                <label key={perm} htmlFor={id} className={cn("inline-flex items-center gap-2 text-[13px]", locked ? "cursor-not-allowed" : "cursor-pointer")}>
                                  <Checkbox id={id} checked={granted.has(perm)} disabled={locked} onCheckedChange={() => toggleAction(perm)} />
                                  {action}
                                </label>
                              );
                            })}
                          </div>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
