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
  Eye,
  EyeOff,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import apiClient from "@/lib/apiClient";
import { useAuth } from "@/contexts/AuthContext";

interface Invitation {
  fullName: string;
  email: string;
  role: string;
  companyName?: string;
  expiresAt: string;
}

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
  const [tokenError, setTokenError] = useState("");

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
    const validate = async () => {
      try {
        const response: any = await apiClient.getInvitation(token || "");
        setInvitation(response?.data?.invitation || null);
      } catch (error: any) {
        setTokenError(
          error.message ||
            "This invitation link is invalid or has expired. Ask your administrator to send a new one."
        );
      } finally {
        setIsValidating(false);
      }
    };

    validate();
  }, [token]);

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
      const response: any = await apiClient.acceptInvitation(token || "", password);

      // Adopt the new session, replacing any account already signed in on this
      // browser — otherwise they would land in someone else's dashboard.
      if (response?.token) {
        apiClient.setToken(response.token);
        await refreshUser();
        setSignedIn(true);
      }

      setIsDone(true);
    } catch (error: any) {
      setFormError(error.message || "Could not set your password. Please try again.");
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

  if (tokenError) {
    return shell(
      <Card className="shadow-elevated">
        <CardHeader className="space-y-4 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive-soft">
            <ShieldAlert className="h-7 w-7 text-destructive-strong" />
          </div>
          <CardTitle className="text-xl font-bold text-foreground">
            Invitation link not valid
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-center">
          <p className="text-muted-foreground">{tokenError}</p>
          <Button
            asChild
            className="h-10 w-full"
          >
            <Link to="/auth">Go to login</Link>
          </Button>
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
          {invitation?.companyName || "Terralabs ERP"} account.
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
            <span className="font-semibold capitalize text-foreground">{invitation?.role}</span>
          </div>
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
