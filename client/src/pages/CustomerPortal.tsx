import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { format } from "date-fns";
import { Download, FileText, LogOut, Package, Receipt, Truck, Upload, Link2Off, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatCard } from "@/components/common/StatTile";
import { EmptyState } from "@/components/common/EmptyState";
import { BrandMark } from "@/components/brand/BrandMark";
import { JobStatusBadge } from "@/components/jobs/JobStatusBadge";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/printWorkflow";
import { useToast } from "@/hooks/use-toast";

/*
  What a customer sees when they open the personal link the print shop sent
  them. The link token is exchanged for a short-lived session (kept in this
  tab's sessionStorage); the API only ever returns this customer's records.
*/

const STORAGE_KEY = "terralabs-portal-session";

interface StoredSession {
  link: string;
  sessionToken: string;
  expiresAt: string;
  customerName: string;
  businessName: string | null;
}

const readStored = (linkToken: string): StoredSession | null => {
  try {
    const s = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null") as StoredSession | null;
    if (!s || s.link !== linkToken.slice(0, 16) || new Date(s.expiresAt) < new Date()) return null;
    return s;
  } catch {
    return null;
  }
};
const writeStored = (s: StoredSession | null) => {
  try {
    if (s) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode: the session simply isn't remembered across reloads */
  }
};

// Shapes returned by the /api/portal/customer/* endpoints.
interface PortalOrder {
  _id: string;
  title: string;
  status: string;
  createdAt: string;
  dueDate?: string;
  printSpecs?: { quantity?: number };
}
interface PortalInvoice {
  _id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  jobTitle?: string;
  paymentStatus: string;
  totalAmount: number;
  balanceAmount: number;
}
interface PortalDelivery {
  _id: string;
  deliveryId?: string;
  jobId?: { title?: string };
  deliveryDate?: string;
  deliveryTimeSlot?: string;
  trackingNumber?: string;
  status: string;
}
interface PortalFile {
  _id: string;
  originalName: string;
  uploadedBy: string;
  createdAt: string;
  jobId?: { title?: string };
}

const PAYMENT_BADGE: Record<string, { label: string; variant: "success" | "warning" | "destructive" | "secondary" }> = {
  paid: { label: "Paid", variant: "success" },
  partial: { label: "Part paid", variant: "warning" },
  pending: { label: "Due", variant: "warning" },
  overdue: { label: "Overdue", variant: "destructive" }
};

type PortalState = "loading" | "ready" | "invalid" | "signed-out";

export default function CustomerPortal() {
  const { token = "" } = useParams();
  const { toast } = useToast();
  const [state, setState] = useState<PortalState>("loading");
  const [session, setSession] = useState<StoredSession | null>(null);
  const [stats, setStats] = useState<{ totalOrders: number; openOrders: number; unpaidInvoices: number; outstandingBalance: number } | null>(null);
  const [orders, setOrders] = useState<PortalOrder[]>([]);
  const [invoices, setInvoices] = useState<PortalInvoice[]>([]);
  const [deliveries, setDeliveries] = useState<PortalDelivery[]>([]);
  const [files, setFiles] = useState<PortalFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (s: StoredSession) => {
    const [st, o, i, d, f] = await Promise.all([
      apiClient.getPortalStats(s.sessionToken),
      apiClient.getPortalOrders(s.sessionToken),
      apiClient.getPortalInvoices(s.sessionToken),
      apiClient.getPortalDeliveries(s.sessionToken),
      apiClient.getPortalFiles(s.sessionToken)
    ]);
    setStats(st.stats);
    setOrders((o.jobs || []) as PortalOrder[]);
    setInvoices((i.invoices || []) as PortalInvoice[]);
    setDeliveries((d.deliveries || []) as PortalDelivery[]);
    setFiles((f.files || []) as PortalFile[]);
  }, []);

  const openFresh = useCallback(async () => {
    const opened = await apiClient.openPortalSession(token);
    const s: StoredSession = {
      link: token.slice(0, 16),
      sessionToken: opened.sessionToken,
      expiresAt: opened.expiresAt,
      customerName: opened.customer.name,
      businessName: opened.business.name
    };
    writeStored(s);
    return s;
  }, [token]);

  const start = useCallback(async () => {
    setState("loading");
    const remembered = readStored(token);
    try {
      const s = remembered || (await openFresh());
      setSession(s);
      await load(s);
      setState("ready");
    } catch (error) {
      writeStored(null);
      // A remembered session may have ended (sign-out elsewhere, server
      // restart of sessions): try the link itself once before giving up.
      if (remembered && (error as { status?: number }).status === 401) {
        try {
          const s = await openFresh();
          setSession(s);
          await load(s);
          setState("ready");
          return;
        } catch {
          /* fall through */
        }
      }
      setState("invalid");
    }
  }, [token, load, openFresh]);

  useEffect(() => {
    start();
  }, [start]);

  const signOut = async () => {
    if (session) await apiClient.portalLogout(session.sessionToken).catch(() => undefined);
    writeStored(null);
    setSession(null);
    setState("signed-out");
  };

  const download = async (file: { _id: string; originalName: string }) => {
    if (!session) return;
    try {
      const blob = await apiClient.downloadPortalFile(session.sessionToken, file._id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.originalName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({ title: "Download failed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const upload = async (file: File) => {
    if (!session) return;
    setUploading(true);
    try {
      await apiClient.uploadPortalFile(session.sessionToken, file, "reference");
      toast({ title: "File sent", description: `${file.name} was shared with ${session.businessName || "the print shop"}.` });
      setFiles(((await apiClient.getPortalFiles(session.sessionToken)).files || []) as PortalFile[]);
    } catch (error) {
      toast({ title: "Upload failed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-dvh bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{session?.businessName || "Order portal"}</div>
            {session && <div className="truncate text-xs text-muted-foreground">Signed in as {session.customerName}</div>}
          </div>
          {state === "ready" && (
            <Button variant="outline" size="sm" onClick={signOut}>
              <LogOut />
              Sign out
            </Button>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">{children}</main>
      <footer className="mx-auto flex max-w-5xl items-center gap-2 px-4 pb-8 text-xs text-muted-foreground sm:px-6">
        <BrandMark className="h-4 w-4" /> Powered by Terralabs ERP
      </footer>
    </div>
  );

  if (state === "loading") {
    return shell(
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Opening your portal…
      </div>
    );
  }

  if (state === "invalid" || state === "signed-out") {
    return shell(
      <div className="rounded-xl border bg-card shadow-card">
        <EmptyState
          icon={state === "signed-out" ? LogOut : Link2Off}
          title={state === "signed-out" ? "You're signed out" : "This link doesn't work any more"}
          description={
            state === "signed-out"
              ? "Open your portal link again whenever you want to check on your orders."
              : "It may have expired or been replaced. Ask the print shop to send you a new portal link."
          }
          action={state === "signed-out" ? <Button onClick={start}>Open portal again</Button> : undefined}
        />
      </div>
    );
  }

  return shell(
    <>
      <div>
        <h1 className="page-title">Hello, {session?.customerName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your orders, invoices, deliveries and files with {session?.businessName || "us"}.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open orders" value={stats?.openOrders ?? 0} icon={Package} />
        <StatCard label="All orders" value={stats?.totalOrders ?? 0} icon={FileText} />
        <StatCard label="Unpaid invoices" value={stats?.unpaidInvoices ?? 0} icon={Receipt} tone={stats?.unpaidInvoices ? "warning" : "default"} />
        <StatCard label="Balance due" value={formatINR(stats?.outstandingBalance ?? 0)} icon={Receipt} tone={stats?.outstandingBalance ? "warning" : "default"} />
      </div>

      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>

        <TabsContent value="orders">
          <div className="rounded-xl border bg-card shadow-card">
            {orders.length === 0 ? (
              <EmptyState compact icon={Package} title="No orders yet" />
            ) : (
              <ul className="divide-y">
                {orders.map((o) => (
                  <li key={o._id} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <div className="min-w-0">
                      <div className="font-medium">{o.title}</div>
                      <div className="text-xs text-muted-foreground">
                        Ordered {format(new Date(o.createdAt), "d MMM yyyy")}
                        {o.dueDate ? ` · Due ${format(new Date(o.dueDate), "d MMM yyyy")}` : ""}
                        {o.printSpecs?.quantity > 1 ? ` · ${Number(o.printSpecs.quantity).toLocaleString("en-IN")} pcs` : ""}
                      </div>
                    </div>
                    <JobStatusBadge status={o.status} className="self-start sm:self-center" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="invoices">
          <div className="rounded-xl border bg-card shadow-card">
            {invoices.length === 0 ? (
              <EmptyState compact icon={Receipt} title="No invoices yet" />
            ) : (
              <ul className="divide-y">
                {invoices.map((inv) => {
                  const badge = PAYMENT_BADGE[inv.paymentStatus] || PAYMENT_BADGE.pending;
                  return (
                    <li key={inv._id} className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
                      <div className="min-w-0">
                        <div className="font-mono text-sm font-medium">{inv.invoiceNumber}</div>
                        <div className="text-xs text-muted-foreground">
                          {format(new Date(inv.invoiceDate), "d MMM yyyy")}
                          {inv.jobTitle ? ` · ${inv.jobTitle}` : ""}
                          {inv.dueDate && inv.balanceAmount > 0 ? ` · Due ${format(new Date(inv.dueDate), "d MMM yyyy")}` : ""}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="num font-semibold">{formatINR(inv.totalAmount)}</div>
                        {inv.balanceAmount > 0 && inv.balanceAmount < inv.totalAmount && (
                          <div className="num text-xs text-muted-foreground">{formatINR(inv.balanceAmount)} due</div>
                        )}
                        <Badge variant={badge.variant} className="mt-1">{badge.label}</Badge>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="deliveries">
          <div className="rounded-xl border bg-card shadow-card">
            {deliveries.length === 0 ? (
              <EmptyState compact icon={Truck} title="No deliveries yet" />
            ) : (
              <ul className="divide-y">
                {deliveries.map((d) => (
                  <li key={d._id} className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
                    <div className="min-w-0">
                      <div className="font-medium">{d.jobId?.title || d.deliveryId}</div>
                      <div className="text-xs text-muted-foreground">
                        {d.deliveryDate ? format(new Date(d.deliveryDate), "d MMM yyyy") : "Date to be confirmed"}
                        {d.deliveryTimeSlot ? ` · ${d.deliveryTimeSlot}` : ""}
                        {d.trackingNumber ? ` · Tracking ${d.trackingNumber}` : ""}
                      </div>
                    </div>
                    <Badge variant={d.status === "delivered" ? "success" : d.status === "failed" ? "destructive" : "info"} className="capitalize">
                      {String(d.status).replace("_", " ")}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="files">
          <div className="rounded-xl border bg-card shadow-card">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
              <p className="text-sm text-muted-foreground">Artwork and documents shared between you and the print shop</p>
              <input ref={fileInput} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              <Button size="sm" onClick={() => fileInput.current?.click()} loading={uploading}>
                {!uploading && <Upload />}
                Send a file
              </Button>
            </div>
            {files.length === 0 ? (
              <EmptyState compact icon={FileText} title="No files yet" />
            ) : (
              <ul className="divide-y">
                {files.map((f) => (
                  <li key={f._id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{f.originalName}</div>
                      <div className="text-xs text-muted-foreground">
                        {f.uploadedBy === "customer" ? "Sent by you" : "Shared with you"} · {format(new Date(f.createdAt), "d MMM yyyy")}
                        {f.jobId?.title ? ` · ${f.jobId.title}` : ""}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon-sm" onClick={() => download(f)} aria-label={`Download ${f.originalName}`}>
                      <Download />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
