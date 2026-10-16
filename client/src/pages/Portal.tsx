import { useCallback, useEffect, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { Link2, Copy, Check, ShieldCheck, Ban, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Panel } from "@/components/common/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import { useAuth } from "@/contexts/AuthContext";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";

interface PortalLink {
  _id: string;
  customerId: string;
  customerName: string;
  createdByName?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
  useCount: number;
  state: "active" | "expired" | "revoked";
}

interface CustomerOption {
  _id: string;
  name: string;
  email?: string;
  company?: string;
}

const STATE_BADGE = {
  active: { label: "Active", variant: "success" },
  expired: { label: "Expired", variant: "secondary" },
  revoked: { label: "Revoked", variant: "destructive" }
} as const;

/**
 * Staff side of the customer portal: give one customer a personal link to
 * follow their own orders, invoices, deliveries and files, and take it back.
 */
const Portal = () => {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("Customer Portal: Manage Access");
  const { toast } = useToast();
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [links, setLinks] = useState<PortalLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [customerId, setCustomerId] = useState("");
  const [days, setDays] = useState("30");
  const [sendEmail, setSendEmail] = useState(false);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ link: string; customerName: string; emailed: boolean; emailError?: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const loadLinks = useCallback(async () => {
    try {
      const res = (await apiClient.getPortalAccessLinks()) as { links: PortalLink[] };
      setLinks(res.links || []);
    } catch (error) {
      toast({ title: "Portal links could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadLinks();
    apiClient
      .getCustomer({ limit: 100, status: "active" })
      .then((res: { customers?: CustomerOption[] }) => setCustomers(res?.customers || []))
      .catch(() => setCustomers([]));
  }, [loadLinks]);

  const selected = customers.find((c) => c._id === customerId);

  const createLink = async () => {
    if (!customerId) return;
    setCreating(true);
    setCopied(false);
    try {
      const res = (await apiClient.createPortalAccess({ customerId, expiresInDays: Number(days), sendEmail })) as {
        link: string;
        emailed: boolean;
        emailError?: string | null;
      };
      setIssued({ link: res.link, customerName: selected?.name || "the customer", emailed: res.emailed, emailError: res.emailError });
      loadLinks();
    } catch (error) {
      toast({ title: "The link could not be created", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const copyLink = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.link);
      setCopied(true);
    } catch {
      toast({ title: "Copy failed", description: "Select the link and copy it manually." });
    }
  };

  const revoke = async (link: PortalLink) => {
    try {
      await apiClient.revokePortalAccess(link._id);
      toast({ title: "Link revoked", description: `${link.customerName} can no longer open the portal with it.` });
      loadLinks();
    } catch (error) {
      toast({ title: "Could not revoke the link", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  return (
    <div className="page-frame">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">Customer Portal</h1>
          <p>Give a customer a personal link to follow their own orders, invoices, deliveries and files</p>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-sm text-info-strong">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Each link opens one customer's records only. It stops working when it expires or when you revoke it. Send it privately — anyone holding
          the link can see that customer's orders.
        </span>
      </div>

      {canManage && (
        <Panel title="Create a portal link" icon={Link2}>
          <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] lg:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="portal-customer">Customer</Label>
              <Select value={customerId} onValueChange={(v) => { setCustomerId(v); setIssued(null); }}>
                <SelectTrigger id="portal-customer">
                  <SelectValue placeholder="Choose a customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c._id} value={c._id}>
                      {c.name}
                      {c.company ? ` — ${c.company}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="portal-days">Link works for</Label>
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger id="portal-days">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["7", "30", "90"].map((d) => (
                    <SelectItem key={d} value={d}>
                      {d} days
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={createLink} disabled={!customerId} loading={creating}>
              <Link2 />
              Create link
            </Button>
            <label className="flex items-center gap-2 text-sm lg:col-span-3">
              <Switch checked={sendEmail} onCheckedChange={setSendEmail} disabled={!selected?.email} aria-label="Email the link to the customer" />
              <span className={selected && !selected.email ? "text-muted-foreground" : undefined}>
                Email it to the customer{selected?.email ? ` (${selected.email})` : selected ? " — no email address on file" : ""}
              </span>
            </label>
          </div>

          {issued && (
            <div className="border-t bg-success-soft/40 p-4 sm:p-5">
              <p className="text-sm font-medium">Link for {issued.customerName}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Copy it now — for security it is not shown again.</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <code className="min-w-0 flex-1 break-all rounded-md border bg-card px-3 py-2 font-mono text-xs">{issued.link}</code>
                <Button variant="outline" onClick={copyLink}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
              {issued.emailed && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-success-strong">
                  <Mail className="h-3.5 w-3.5" /> Emailed to the customer.
                </p>
              )}
              {issued.emailError && <p className="mt-2 text-xs text-warning-strong">Not emailed: {issued.emailError}</p>}
            </div>
          )}
        </Panel>
      )}

      <Panel title="Links issued" count={loading ? undefined : links.filter((l) => l.state === "active").length} description="Active links first">
        {loading ? (
          <div className="space-y-2 p-4 sm:p-5">
            {[0, 1].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
          </div>
        ) : links.length === 0 ? (
          <EmptyState compact icon={Link2} title="No portal links yet" description="Create one above to give a customer access." />
        ) : (
          <ul className="divide-y">
            {[...links]
              .sort((a, b) => Number(b.state === "active") - Number(a.state === "active"))
              .map((l) => {
                const badge = STATE_BADGE[l.state] || STATE_BADGE.expired;
                return (
                  <li key={l._id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{l.customerName}</span>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span>
                          Created {format(new Date(l.createdAt), "d MMM yyyy")}
                          {l.createdByName ? ` by ${l.createdByName}` : ""}
                        </span>
                        <span>
                          {l.state === "revoked" && l.revokedAt
                            ? `Revoked ${format(new Date(l.revokedAt), "d MMM yyyy")}`
                            : `${l.state === "expired" ? "Expired" : "Expires"} ${format(new Date(l.expiresAt), "d MMM yyyy")}`}
                        </span>
                        <span>{l.lastUsedAt ? `Last opened ${formatDistanceToNow(new Date(l.lastUsedAt), { addSuffix: true })}` : "Not opened yet"}</span>
                      </div>
                    </div>
                    {canManage && l.state === "active" && (
                      <Button variant="outline" size="sm" onClick={() => revoke(l)}>
                        <Ban />
                        Revoke
                      </Button>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </Panel>
    </div>
  );
};

export default Portal;
