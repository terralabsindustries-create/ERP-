import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Small label above the title, e.g. the module name */
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * The title row every page starts with. Actions sit to the right of the title
 * on wide screens and wrap underneath it on phones. Styled by .page-heading-row
 * in index.css, which older pages use directly.
 */
export function PageHeader({ title, description, eyebrow, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("page-heading-row", className)}>
      <div>
        {eyebrow && <div className="section-label mb-1">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {description && <div className="max-w-3xl">{description}</div>}
      </div>
      {actions && <div className="no-print">{actions}</div>}
    </div>
  );
}
