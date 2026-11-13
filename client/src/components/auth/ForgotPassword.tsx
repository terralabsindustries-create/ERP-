import { useEffect, useState } from "react";
import { ArrowLeft, Eye, EyeOff, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import apiClient from "@/lib/apiClient";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const RESEND_COOLDOWN_SECONDS = 60; // the server sends at most one code a minute per address

type ApiError = Error & { code?: string; status?: number };

const describe = (error: unknown, fallback: string) => {
  const err = error as ApiError;
  if (err?.code === "EMAIL_NOT_CONFIGURED" || err?.code === "EMAIL_AUTH_FAILED") {
    return "Email isn't set up on the server yet, so no code can be sent. Ask your administrator to reset your password from User Management.";
  }
  if (err?.message === "Failed to fetch") return "We could not reach the server. Check your connection and try again.";
  return err?.message || fallback;
};

/**
 * Forgot password, in two steps: ask for a code by email, then enter the code
 * with a new password. On success the person is signed straight in.
 */
export function ForgotPassword({ initialEmail, onBack }: { initialEmail: string; onBack: (email: string) => void }) {
  const { signIn } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState<"email" | "reset">("email");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.requestPasswordReset(email.trim());
      setStep("reset");
      setResendIn(RESEND_COOLDOWN_SECONDS);
      setTimeout(() => document.getElementById("reset-code")?.focus(), 0);
    } catch (cause) {
      setError(describe(cause, "The code could not be sent. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async () => {
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await apiClient.resetPassword(email.trim(), code, password);
      toast({ title: "Password changed", description: "Signing you in with your new password." });
      const { error: signInError } = await signIn(email.trim(), password);
      if (signInError) onBack(email.trim());
    } catch (cause) {
      const err = cause as ApiError;
      if (err?.code === "RESET_CODE_LOCKED" || err?.code === "RESET_CODE_EXPIRED") setCode("");
      setError(describe(cause, "Your password could not be changed. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const labelClass = "text-[13px] font-medium text-foreground";
  const inputClass = "h-11 bg-card";

  return (
    <div>
      <button
        type="button"
        onClick={() => onBack(email.trim())}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to sign in
      </button>

      <h2 className="text-[26px] font-semibold tracking-tight sm:text-[30px]">
        {step === "email" ? "Forgot your password?" : "Choose a new password"}
      </h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {step === "email"
          ? "Enter the email you sign in with and we'll send you a 6-digit code."
          : "Enter the code from the email and your new password."}
      </p>

      {step === "email" ? (
        <form
          className="mt-8 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            sendCode();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="reset-email" className={labelClass}>Email</Label>
            <Input
              id="reset-email"
              type="email"
              autoComplete="email"
              placeholder="you@yourpress.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className={inputClass}
            />
          </div>
          {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          <Button type="submit" className="mt-2 h-11 w-full" disabled={busy || !email.trim()}>
            {busy ? "Sending code…" : "Send reset code"}
          </Button>
        </form>
      ) : (
        <form
          className="mt-8 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            resetPassword();
          }}
        >
          <div className="flex items-start gap-3 rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-sm text-info-strong">
            <MailCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              If <span className="font-semibold">{email.trim()}</span> has a Carbon account, a code is on its way. It expires in 10 minutes —
              check your spam folder if you don't see it.
            </span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-code" className={labelClass}>6-digit code</Label>
            <Input
              id="reset-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              className={`${inputClass} font-mono tracking-[0.4em]`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-password" className={labelClass}>New password</Label>
            <div className="relative">
              <Input
                id="reset-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                placeholder="At least 6 characters"
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className={`${inputClass} pr-10`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 p-0 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-confirm" className={labelClass}>Confirm new password</Label>
            <Input
              id="reset-confirm"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              className={inputClass}
            />
          </div>
          {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          <Button type="submit" className="mt-2 h-11 w-full" disabled={busy || code.length !== 6}>
            {busy ? "Changing password…" : "Change password and sign in"}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
            >
              Use a different email
            </button>
            <button
              type="button"
              className="font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
              disabled={busy || resendIn > 0}
              onClick={sendCode}
            >
              {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
