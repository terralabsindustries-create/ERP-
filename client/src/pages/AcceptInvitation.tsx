import { BrandLogo } from "@/components/brand/BrandMark";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Building2,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import { format } from "date-fns";
import apiClient from "@/lib/apiClient";
import { useAuth } from "@/contexts/AuthContext";

interface Invitation {
  fullName: string;
  email: string;
  role: string;
  roleName?: string | null;
  department?: string | null;
  companyName?: string;
  expiresAt: string;
}

type ProblemKind = "used" | "expired" | "invalid" | "unreachable";
interface LinkProblem {
  kind: ProblemKind;
  message: string;
}

// How each kind of unusable link is presented. The API's message is the body.
const PROBLEMS: Record<ProblemKind, { title: string; icon: typeof ShieldAlert; tone: "success" | "warning" | "destructive" }> = {
  used: { title: "Invitation already used", icon: CheckCircle2, tone: "success" },
  expired: { title: "Invitation expired", icon: Clock, tone: "warning" },
  invalid: { title: "Invitation link not valid", icon: ShieldAlert, tone: "destructive" },
  unreachable: { title: "Couldn't check your invitation", icon: WifiOff, tone: "warning" },
};

const TONE_CLASSES = {
  success: "bg-success-soft text-success-strong",
  warning: "bg-warning-soft text-warning-strong",
  destructive: "bg-destructive-soft text-destructive-strong",
};

// Maps an API error onto a link problem, or null if the link itself is fine
// (a validation error on the password, say).
const linkProblem = (raw: unknown): LinkProblem | null => {
  const error = (raw ?? {}) as { message?: string; code?: string; status?: number };
  const message = error.message || "";
  switch (error.code) {
    case "INVITATION_USED":
      return { kind: "used", message };
    case "INVITATION_EXPIRED":
      return { kind: "expired", message };
    case "INVITATION_INVALID":
      return { kind: "invalid", message };
  }
  // No status means the request never got an answer; 5xx means the server failed.
  if (!error.status || error.status >= 500) {
    return { kind: "unreachable", message: message || "The server could not be reached. Check your connection and try again." };
  }
  if (error.status === 400 || error.status === 404 || error.status === 410) {
    // Older servers answered every unusable link with a plain 400.
    return { kind: "invalid", message: message || "This invitation link is invalid or has expired. Ask your administrator to send a new one." };
  }
  return null;
};

const roleLabel = (invitation: Invitation | null) => {
  if (!invitation) return "";
  if (invitation.roleName) return invitation.roleName;
  return invitation.role ? invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1) : "";
};

/**
 * Landing page for the one-time link in a staff invitation email. The token in
 * the URL is the only credential involved: it is validated on load, spent when
 * the password is set, and useless afterwards.
 */
export default function AcceptInvitation() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();

  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [isValidating, setIsValidating] = useState(true);
  const [problem, setProblem] = useState<LinkProblem | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDone, setIsDone] = useState(false);
  // Accepting signs them in, so the button leads to the dashboard. If no token
  // comes back we fall back to sending them to the login page instead.
  const [signedIn, setSignedIn] = useState(false);
  const destination = signedIn ? "/" : "/auth";

  useEffect(() => {
    let cancelled = false;
    const validate = async () => {
      setIsValidating(true);
      setProblem(null);
      try {
        const response = (await apiClient.getInvitation(token || "")) as { data?: { invitation?: Invitation } };
        if (!cancelled) setInvitation(response?.data?.invitation || null);
      } catch (error) {
        if (!cancelled) {
          setProblem(
            linkProblem(error) || {
              kind: "invalid",
              message: (error instanceof Error && error.message) || "This invitation link can't be used. Ask your administrator to send a new one.",
            }
          );
        }
      } finally {
        if (!cancelled) setIsValidating(false);
      }
    };

    validate();
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  useEffect(() => {
    if (!isDone) return;
    const timer = setTimeout(() => navigate(destination, { replace: true }), 4000);
    return () => clearTimeout(timer);
  }, [isDone, destination, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");

    if (password.length < 6) {
      setFormError("Password must be at least 6 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setFormError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = (await apiClient.acceptInvitation(token || "", password)) as { token?: string };

      // Adopt the new session, replacing any account already signed in on this
      // browser — otherwise they would land in someone else's dashboard.
      if (response?.token) {
        apiClient.setToken(response.token);
        await refreshUser();
        setSignedIn(true);
      }

      setIsDone(true);
    } catch (error) {
      // The link stopped working while the form was open (used in another tab,
      // expired, or replaced by a newer invitation): show that, not a form error.
      const code = (error as { code?: string } | null)?.code || "";
      if (["INVITATION_USED", "INVITATION_EXPIRED", "INVITATION_INVALID"].includes(code)) {
        setProblem(linkProblem(error));
      } else {
        setFormError((error instanceof Error && error.message) || "Could not set your password. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 bg-background p-4">
      <BrandLogo />
      <div className="w-full max-w-md">{children}</div>
    </div>
  );

  if (isValidating) {
    return shell(
      <Card className="shadow-elevated">
        <CardContent className="flex flex-col items-center gap-4 py-16">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-muted-foreground">Checking your invitation…</p>
        </CardContent>
      </Card>
    );
  }

  if (problem) {
    const { title, icon: Icon, tone } = PROBLEMS[problem.kind];
    return shell(
      <Card className="shadow-elevated">
        <CardHeader className="space-y-4 text-center">
          <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${TONE_CLASSES[tone]}`}>
            <Icon className="h-7 w-7" />
          </div>
          <CardTitle className="text-xl font-bold text-foreground">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-center">
          <p className="text-muted-foreground">{problem.message}</p>
          {problem.kind === "unreachable" ? (
            <Button className="h-10 w-full" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
          ) : (
            <Button asChild className="h-10 w-full" variant={problem.kind === "used" ? "default" : "outline"}>
              <Link to="/auth">{problem.kind === "used" ? "Sign in" : "Go to sign in"}</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (isDone) {
    return shell(
      <Card className="shadow-elevated">
        <CardHeader className="space-y-4 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success-soft">
            <CheckCircle2 className="h-7 w-7 text-success-strong" />
          </div>
          <CardTitle className="text-xl font-bold text-foreground">
            Your account is active
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-center">
          <p className="text-muted-foreground">
            {signedIn ? (
              <>
                You're signed in as{" "}
                <span className="font-semibold text-foreground">{invitation?.email}</span>. Next time,
                sign in with that address and the password you just set.
              </>
            ) : (
              <>
                You can now sign in with{" "}
                <span className="font-semibold text-foreground">{invitation?.email}</span> and the
                password you just set.
              </>
            )}
          </p>
          <Button
            onClick={() => navigate(destination, { replace: true })}
            className="h-10 w-full"
          >
            {signedIn ? "Go to Dashboard" : "Go to login"}
          </Button>
          <p className="text-xs text-muted-foreground">Taking you there automatically…</p>
        </CardContent>
      </Card>
    );
  }

  return shell(
    <Card className="shadow-elevated">
      <CardHeader className="space-y-4 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
          <Building2 className="h-7 w-7 text-primary" />
        </div>
        <CardTitle className="text-xl font-semibold">Create your password</CardTitle>
        <p className="text-sm text-muted-foreground">
          Welcome, {invitation?.fullName}. Set a password to activate your{" "}
          {invitation?.companyName || "Carbon"} account.
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="rounded-xl border border-border bg-muted/50 p-4 text-sm">
          <div className="flex justify-between gap-4 py-1">
            <span className="text-muted-foreground">Email</span>
            <span className="font-semibold text-foreground">{invitation?.email}</span>
          </div>
          <div className="flex justify-between gap-4 py-1">
            <span className="text-muted-foreground">Role</span>
            <span className="font-semibold text-foreground">{roleLabel(invitation)}</span>
          </div>
          {invitation?.department && (
            <div className="flex justify-between gap-4 py-1">
              <span className="text-muted-foreground">Department</span>
              <span className="font-semibold text-foreground">{invitation.department}</span>
            </div>
          )}
          {invitation?.expiresAt && (
            <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
              This link works once and expires {format(new Date(invitation.expiresAt), "d MMM yyyy, h:mm a")}.
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="new-password" className="text-sm font-semibold text-foreground/80">
              New Password
            </Label>
            <div className="relative">
              <Input
                id="new-password"
                type={showPassword ? "text" : "password"}
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoFocus
                className="h-10 pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 h-9 w-9 -translate-y-1/2 text-muted-foreground/70 hover:text-muted-foreground"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password" className="text-sm font-semibold text-foreground/80">
              Confirm Password
            </Label>
            <Input
              id="confirm-password"
              type={showPassword ? "text" : "password"}
              placeholder="Re-enter your password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={6}
              className="h-10"
            />
          </div>

          {formError && (
            <Alert className="border-destructive/30 bg-destructive/10 text-destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <Button
            type="submit"
            disabled={isSubmitting}
            className="h-10 w-full"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Setting password…
              </>
            ) : (
              "Set Password"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
