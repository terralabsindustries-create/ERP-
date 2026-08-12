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

  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [isValidating, setIsValidating] = useState(true);
  const [tokenError, setTokenError] = useState("");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDone, setIsDone] = useState(false);

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

  // Once the password is set the account is active; send them to the normal
  // login page rather than signing them in off the back of an email link.
  useEffect(() => {
    if (!isDone) return;
    const timer = setTimeout(() => navigate("/auth"), 4000);
    return () => clearTimeout(timer);
  }, [isDone, navigate]);

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
      await apiClient.acceptInvitation(token || "", password);
      setIsDone(true);
    } catch (error: any) {
      setFormError(error.message || "Could not set your password. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-orange-50/30 to-white p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-orange-200/20 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-orange-300/20 rounded-full blur-3xl animate-pulse delay-1000" />
      </div>
      <div className="relative z-10 w-full max-w-md">{children}</div>
    </div>
  );

  if (isValidating) {
    return shell(
      <Card className="border-2 border-orange-100 rounded-2xl shadow-xl">
        <CardContent className="flex flex-col items-center gap-4 py-16">
          <Loader2 className="h-10 w-10 animate-spin text-orange-500" />
          <p className="text-gray-600">Checking your invitation…</p>
        </CardContent>
      </Card>
    );
  }

  if (tokenError) {
    return shell(
      <Card className="border-2 border-orange-100 rounded-2xl shadow-xl">
        <CardHeader className="space-y-4 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
            <ShieldAlert className="h-7 w-7 text-red-600" />
          </div>
          <CardTitle className="text-xl font-bold text-gray-900">
            Invitation link not valid
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-center">
          <p className="text-gray-600">{tokenError}</p>
          <Button
            asChild
            className="h-12 w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 font-semibold text-white"
          >
            <Link to="/auth">Go to login</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (isDone) {
    return shell(
      <Card className="border-2 border-orange-100 rounded-2xl shadow-xl">
        <CardHeader className="space-y-4 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
            <CheckCircle2 className="h-7 w-7 text-green-600" />
          </div>
          <CardTitle className="text-xl font-bold text-gray-900">
            Your account is active
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-center">
          <p className="text-gray-600">
            You can now sign in with{" "}
            <span className="font-semibold text-gray-900">{invitation?.email}</span> and the
            password you just set.
          </p>
          <Button
            onClick={() => navigate("/auth")}
            className="h-12 w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 font-semibold text-white"
          >
            Go to login
          </Button>
          <p className="text-xs text-gray-500">Taking you there automatically…</p>
        </CardContent>
      </Card>
    );
  }

  return shell(
    <Card className="border-2 border-orange-100 rounded-2xl shadow-xl">
      <CardHeader className="space-y-4 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-orange-100">
          <Building2 className="h-7 w-7 text-orange-600" />
        </div>
        <CardTitle className="text-2xl font-bold text-gray-900">Create your password</CardTitle>
        <p className="text-sm text-gray-600">
          Welcome, {invitation?.fullName}. Set a password to activate your{" "}
          {invitation?.companyName || "SerpY ERP"} account.
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm">
          <div className="flex justify-between gap-4 py-1">
            <span className="text-gray-500">Email</span>
            <span className="font-semibold text-gray-900">{invitation?.email}</span>
          </div>
          <div className="flex justify-between gap-4 py-1">
            <span className="text-gray-500">Role</span>
            <span className="font-semibold capitalize text-gray-900">{invitation?.role}</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="new-password" className="text-sm font-semibold text-gray-700">
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
                className="h-12 rounded-xl border-2 border-gray-200 pr-12 focus:border-orange-500"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 h-9 w-9 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password" className="text-sm font-semibold text-gray-700">
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
              className="h-12 rounded-xl border-2 border-gray-200 focus:border-orange-500"
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
            className="h-12 w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 font-semibold text-white shadow-lg shadow-orange-500/30"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
