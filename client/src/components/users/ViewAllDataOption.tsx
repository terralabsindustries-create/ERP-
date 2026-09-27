import { Checkbox } from "@/components/ui/checkbox";

/**
 * Roles that can be allowed to see every team member's records. Mirrors
 * VIEW_ALL_ROLES in the backend's users route — staff always see only their own.
 */
export const VIEW_ALL_ROLES = ["manager", "accountant"];

/** Only the admin, or a login that already has it, can hand this out. */
export const canGrantViewAll = (user: any) =>
  user?.role === "admin" || user?.canViewAllData === true;

interface ViewAllDataOptionProps {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/**
 * The "Can view all staff data" tick box. Shared by the invite form and the
 * edit dialog so the option reads the same wherever it is set.
 */
export function ViewAllDataOption({ id, checked, onChange }: ViewAllDataOptionProps) {
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border p-4 transition-all ${
        checked ? "border-primary/40 bg-primary/5" : "border-input bg-card"
      }`}
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
      />
      <div className="space-y-1">
        <label htmlFor={id} className="cursor-pointer text-sm font-semibold">
          Can view all staff data
        </label>
        <p className="text-xs text-muted-foreground">
          See invoices created by every team member. Leave unticked and this login only sees
          the invoices it creates itself.
        </p>
      </div>
    </div>
  );
}
