import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  PERMISSION_TREE,
  ALL_PERMISSIONS,
  actionName,
  actionsForModule,
} from "@/lib/permissions";

interface PermissionSelectorProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Dashboard is always granted, so its checkbox is locked on. */
  lockDashboard?: boolean;
}

/**
 * The module/action permission tree. Shared by the invite form and the edit
 * dialog so a login's permissions look and behave the same wherever they are
 * set — there is one place to change the rules.
 */
export function PermissionSelector({ value, onChange, lockDashboard = true }: PermissionSelectorProps) {
  // Toggling a MODULE. Granting one turns on its "View" action so the user can
  // actually open the section; revoking one drops every action beneath it, so a
  // stored list never implies access to a section the user cannot reach.
  const toggleModule = (module: string) => {
    const children = actionsForModule(module);

    if (value.includes(module)) {
      onChange(value.filter((p) => p !== module && !children.includes(p)));
      return;
    }

    const viewAction = actionName(module, "View");
    const next = [...value, module];
    if (children.includes(viewAction)) next.push(viewAction);
    onChange(next);
  };

  // Toggling an ACTION. Only reachable when its module is already granted.
  const toggleAction = (action: string) => {
    onChange(
      value.includes(action) ? value.filter((p) => p !== action) : [...value, action]
    );
  };

  const toggleAll = () => {
    onChange(value.length === ALL_PERMISSIONS.length ? ["Dashboard"] : [...ALL_PERMISSIONS]);
  };

  return (
    <div className="space-y-4 p-4 md:p-6 bg-muted rounded-lg border border-input">
      <div className="flex justify-between items-center gap-4">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold">Permissions</h3>
          <p className="text-xs text-muted-foreground">
            Select only the features this user should access
          </p>
          <span className="text-xs text-muted-foreground">
            {value.length} / {ALL_PERMISSIONS.length} selected
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={toggleAll} className="whitespace-nowrap">
          {value.length === ALL_PERMISSIONS.length ? "Deselect All" : "Select All"}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {PERMISSION_TREE.map(({ module, actions }) => {
          const isDashboard = module === "Dashboard";
          const moduleLocked = isDashboard && lockDashboard;
          const moduleGranted = value.includes(module);

          return (
            <div
              key={module}
              className={`rounded-lg border transition-all ${
                moduleLocked
                  ? "border-primary/50 bg-primary/5"
                  : moduleGranted
                  ? "border-primary/40 bg-card"
                  : "border-input bg-card"
              }`}
            >
              <div className="flex items-center space-x-2 p-3">
                <Checkbox
                  id={`perm-${module}`}
                  checked={moduleGranted}
                  disabled={moduleLocked}
                  onCheckedChange={() => {
                    if (!moduleLocked) toggleModule(module);
                  }}
                />
                <label
                  htmlFor={`perm-${module}`}
                  className={`text-sm font-semibold flex-1 ${
                    moduleLocked ? "cursor-not-allowed text-primary" : "cursor-pointer"
                  }`}
                >
                  {module}
                  {moduleLocked && <span className="text-xs text-primary ml-1">(Required)</span>}
                </label>
                {actions.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    {actions.filter((a) => value.includes(actionName(module, a))).length}/{actions.length}
                  </span>
                )}
              </div>

              {/* Actions inside this module — greyed out until the module is granted */}
              {actions.length > 0 && (
                <div className="pl-9 pr-3 pb-3 space-y-1.5">
                  {actions.map((action) => {
                    const perm = actionName(module, action);
                    const disabled = !moduleGranted;
                    return (
                      <div key={perm} className="flex items-center space-x-2">
                        <Checkbox
                          id={`perm-${perm}`}
                          checked={value.includes(perm)}
                          disabled={disabled}
                          onCheckedChange={() => {
                            if (!disabled) toggleAction(perm);
                          }}
                        />
                        <label
                          htmlFor={`perm-${perm}`}
                          className={`text-xs flex-1 ${
                            disabled ? "text-muted-foreground/50 cursor-not-allowed" : "cursor-pointer"
                          }`}
                        >
                          {action}
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
