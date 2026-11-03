import { useEffect, useRef, useState } from "react";
import { AlertCircle, BellRing, Check, ChevronDown, FileSignature, Image, KeyRound, Loader2, Receipt, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// Facebook SDK global type declaration
declare global {
  interface Window {
    FB: any;
    fbAsyncInit: () => void;
  }
}

const FACEBOOK_ORIGINS = ["https://www.facebook.com", "https://web.facebook.com"];

// Loaded once per session; later visits to the page reuse it.
let sdkPromise: Promise<void> | null = null;
function loadFacebookSdk(): Promise<void> {
  if (window.FB) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    // Defined before the script loads: the SDK calls it as soon as it is ready.
    window.fbAsyncInit = () => {
      window.FB.init({
        appId: import.meta.env.VITE_FACEBOOK_APP_ID || "1076724650669349",
        autoLogAppEvents: true,
        xfbml: true,
        version: "v23.0"
      });
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      script.remove();
      sdkPromise = null;
      reject(new Error("Facebook sign-in couldn't load. Check the internet connection, or turn off an ad blocker for this site."));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

const STEPS = ["Sign in with Facebook", "Choose your business", "Pick the WhatsApp number", "Link it to Carbon"];

const USES = [
  { icon: Receipt, title: "Invoices", text: "Send the invoice with its amount and due date." },
  { icon: FileSignature, title: "Quotations", text: "Share quotations for the customer to confirm." },
  { icon: BellRing, title: "Payment reminders", text: "Remind customers automatically when a payment is late." },
  { icon: Image, title: "Proofs", text: "Send job proofs for sign-off before printing." }
];

type Session = { waba_id: string; phone_number_id: string };

/**
 * The page before WhatsApp is connected: what it is for, Meta's sign-up flow,
 * and API keys as the fallback for accounts set up by hand.
 */
export function ConnectWhatsApp({ canEdit, onConnected }: { canEdit: boolean; onConnected: () => void }) {
  const { toast } = useToast();
  const [sdkState, setSdkState] = useState<"loading" | "ready" | "failed">(window.FB ? "ready" : "loading");
  // 0 = not started, 1 = the Meta window is open (STEPS 1–3 happen there), 4 = linking
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ wabaId: "", phoneNumberId: "", accessToken: "" });
  const [savingManual, setSavingManual] = useState(false);

  // The sign-up popup answers twice — the login code through FB.login, the
  // account IDs through postMessage — in either order. Whichever arrives
  // second starts the exchange.
  const codeRef = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const exchangingRef = useRef(false);
  const waitTimer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef({ onConnected, toast });
  latest.current = { onConnected, toast };

  const fail = (message: string) => {
    clearTimeout(waitTimer.current);
    codeRef.current = null;
    sessionRef.current = null;
    setError(message);
    setStep(0);
  };

  const exchange = async () => {
    const code = codeRef.current;
    const session = sessionRef.current;
    if (!code || !session || exchangingRef.current) return;
    clearTimeout(waitTimer.current);
    exchangingRef.current = true;
    setStep(4);
    try {
      const result: any = await apiClient.exchangeWhatsAppToken(code, session.waba_id, session.phone_number_id);
      // apiClient hands back the envelope's `data`, so success shows as the account details.
      if (!(result && (result.wabaId || result.phoneNumberId || result.status === "success"))) {
        throw new Error(result?.message || "Meta didn't confirm the connection.");
      }
      codeRef.current = null;
      sessionRef.current = null;
      latest.current.toast({ title: "WhatsApp connected", description: "Your WhatsApp Business number is linked to Carbon." });
      latest.current.onConnected();
    } catch (e: any) {
      fail(e.message || "Verification failed. Please try again.");
    } finally {
      exchangingRef.current = false;
    }
  };
  const exchangeRef = useRef(exchange);
  exchangeRef.current = exchange;

  useEffect(() => {
    let alive = true;
    loadFacebookSdk()
      .then(() => alive && setSdkState("ready"))
      .catch((e) => {
        if (!alive) return;
        setSdkState("failed");
        setError(e.message);
      });

    const onMessage = (event: MessageEvent) => {
      if (!FACEBOOK_ORIGINS.includes(event.origin) || typeof event.data !== "string") return;
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        return; // Facebook posts other, non-JSON messages too
      }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event === "FINISH" || data.event === "FINISH_ONLY_WABA") {
        if (!data.data?.waba_id || !data.data?.phone_number_id) {
          fail("Meta didn't send a phone number. Run the setup again and choose or add a number.");
          return;
        }
        sessionRef.current = data.data;
        setStep(4);
        exchangeRef.current();
      } else if (data.event === "CANCEL") {
        clearTimeout(waitTimer.current);
        codeRef.current = null;
        sessionRef.current = null;
        setStep(0);
      } else if (data.event === "ERROR") {
        fail(data.data?.error_message || "Meta reported an error during sign-up. Please try again.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      alive = false;
      clearTimeout(waitTimer.current);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  const launch = () => {
    if (!window.FB) return;
    setError(null);
    codeRef.current = null;
    sessionRef.current = null;
    setStep(1);
    window.FB.login(
      (response: any) => {
        const code = response?.authResponse?.code;
        if (!code) {
          // Closing the popup lands here too; CANCEL may already have reset the steps.
          setStep(0);
          if (!sessionRef.current) setError((e) => e || "Sign-up was closed before it finished.");
          return;
        }
        codeRef.current = code;
        if (sessionRef.current) {
          exchangeRef.current();
        } else {
          waitTimer.current = setTimeout(() => fail("Meta didn't send the account details. Please run the setup again."), 30000);
        }
      },
      {
        config_id: import.meta.env.VITE_WHATSAPP_CONFIG_ID || "1021653400474138",
        response_type: "code",
        override_default_response_type: true,
        extras: { version: "v3" }
      }
    );
  };

  const saveManual = async () => {
    const wabaId = manual.wabaId.trim();
    const phoneNumberId = manual.phoneNumberId.trim();
    const accessToken = manual.accessToken.trim();
    if (!wabaId || !phoneNumberId || !accessToken) {
      toast({ title: "Fill in all three fields", description: "The account ID, phone number ID and access token are all needed.", variant: "destructive" });
      return;
    }
    setSavingManual(true);
    try {
      await apiClient.setupWhatsApp({ enabled: true, wabaId, phoneNumberId, accessToken });
      toast({ title: "Credentials saved", description: "Checking them with Meta now." });
      onConnected();
    } catch (e: any) {
      toast({ title: "Couldn't save", description: e.message || "Failed to save settings.", variant: "destructive" });
    } finally {
      setSavingManual(false);
    }
  };

  const running = step > 0;

  return (
    <div className="grid overflow-hidden rounded-xl border bg-card shadow-card lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="space-y-5 border-b bg-muted/30 p-5 sm:p-6 lg:border-b-0 lg:border-r">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Connect your WhatsApp Business number</h2>
          <p className="mt-1 text-sm text-muted-foreground">Customers get messages from your own business number, and replies come straight back to it.</p>
        </div>
        <ul className="space-y-3.5">
          {USES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success-strong">
                <Icon className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-medium">{title}</p>
                <p className="text-xs text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ul>
        <div className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Before you start</p>
          You need a Facebook login that manages your business on Meta, and a phone number that can get a verification code by SMS or call.
        </div>
      </div>

      <div className="space-y-5 p-5 sm:p-6">
        {!canEdit ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <p className="font-medium">WhatsApp isn't connected yet</p>
            <p className="max-w-xs text-sm text-muted-foreground">Ask the business owner, or someone who can edit settings, to connect it.</p>
          </div>
        ) : (
          <>
            <div>
              <p className="section-label">Set up with Meta</p>
              <p className="mt-1 text-sm text-muted-foreground">A Meta window opens and walks you through it. It takes about a minute.</p>
            </div>

            <ol className="space-y-0">
              {STEPS.map((label, i) => {
                const n = i + 1;
                const done = step === 4 && n < 4;
                const current = step === 1 ? n < 4 : step === n;
                return (
                  <li key={label} className="relative flex items-center gap-3 pb-4 last:pb-0">
                    {n < STEPS.length && <span className={cn("absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-px", done ? "bg-success" : "bg-border")} aria-hidden />}
                    <span
                      className={cn(
                        "relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                        done && "border-success bg-success text-success-foreground",
                        current && "border-primary bg-primary-soft text-primary-strong",
                        !done && !current && "bg-card text-muted-foreground"
                      )}
                    >
                      {done ? <Check className="h-3.5 w-3.5" /> : current && n === 4 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : n}
                    </span>
                    <span className={cn("text-sm", current ? "font-medium text-foreground" : done ? "text-foreground" : "text-muted-foreground")}>{label}</span>
                  </li>
                );
              })}
            </ol>

            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive-soft px-3 py-2.5 text-sm text-destructive-strong">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button
              onClick={launch}
              disabled={running || sdkState !== "ready"}
              size="lg"
              className="w-full bg-[#1877F2] text-white hover:bg-[#166FE5]"
            >
              {running || sdkState === "loading" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <svg className="fill-current" viewBox="0 0 24 24" aria-hidden>
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                </svg>
              )}
              {running ? "Finish the steps in the Meta window" : sdkState === "loading" ? "Loading Facebook sign-in…" : error ? "Try again with Facebook" : "Continue with Facebook"}
            </Button>

            <Collapsible open={manualOpen} onOpenChange={setManualOpen} className="rounded-lg border">
              <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <span className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  Connect with API keys instead
                </span>
                <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", manualOpen && "rotate-180")} />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 border-t px-3 pb-3 pt-3">
                <p className="text-xs text-muted-foreground">
                  For a number already set up in a Meta app. Find the IDs in the Meta App Dashboard under WhatsApp → API Setup.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-waba">WhatsApp Business Account ID</Label>
                  <Input id="wa-waba" inputMode="numeric" value={manual.wabaId} onChange={(e) => setManual((m) => ({ ...m, wabaId: e.target.value }))} placeholder="e.g. 123456789012345" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-phone-id">Phone number ID</Label>
                  <Input id="wa-phone-id" inputMode="numeric" value={manual.phoneNumberId} onChange={(e) => setManual((m) => ({ ...m, phoneNumberId: e.target.value }))} placeholder="e.g. 109876543210987" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-token">Permanent access token</Label>
                  <Input id="wa-token" type="password" autoComplete="off" value={manual.accessToken} onChange={(e) => setManual((m) => ({ ...m, accessToken: e.target.value }))} placeholder="EAAI…" />
                  <p className="text-xs text-muted-foreground">Create a system user token in Meta Business Settings → System users. Temporary tokens stop working within a day.</p>
                </div>
                <Button onClick={saveManual} disabled={savingManual} className="w-full">
                  {savingManual && <Loader2 className="animate-spin" />}
                  Save and connect
                </Button>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </div>
    </div>
  );
}
