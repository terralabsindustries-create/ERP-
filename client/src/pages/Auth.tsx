import { useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Eye, EyeOff, AlertCircle, UserCheck, Calculator, SquareKanban, Layers, FileText } from "lucide-react";
import { BrandLogo } from "@/components/brand/BrandMark";
import { useAuth } from "@/contexts/AuthContext";
import { OTPVerification } from "@/components/auth/OTPVerification";
import { BASE_URL } from "@/lib/apiClient";

// Form field name -> the suffix of its input id on the sign-up tab.
const FIELD_INPUT_IDS: Record<string, string> = {
  fullName: "name",
  email: "email",
  password: "password",
  phone: "phone",
  companyName: "company",
};

export default function Auth() {
  const { user, signIn, signUp, loading } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showOTPVerification, setShowOTPVerification] = useState(false);
  const [activeTab, setActiveTab] = useState("signin");
  // Signup failures are shown in a dialog. `existingAccount` gets its own
  // treatment because the fix is an action (sign in), not just a message.
  const [signUpError, setSignUpError] = useState<
    { kind: "existingAccount" | "generic"; message: string } | null
  >(null);
  // Per-field messages shown under the input they belong to. A dialog is the
  // wrong place for "that email looks wrong" — the user needs to see which box.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    fullName: "",
    phone: "",
    companyName: "",
  });

  // Redirect if already authenticated
  if (user && !loading) {
    return <Navigate to="/" replace />;
  }

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    await signIn(formData.email, formData.password);
    setIsLoading(false);
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});

    // The server only checks the password at the verify-OTP step, which would
    // mean failing after the code has already been typed in. Catch it here.
    if (formData.password.length < 6) {
      setFieldErrors({ password: "Password must be at least 6 characters." });
      document.getElementById("signup-password")?.focus();
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(`${BASE_URL}/auth/send-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: formData.email,
          fullName: formData.fullName,
          phone: formData.phone,
          companyName: formData.companyName
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setShowOTPVerification(true);
      } else if (data.errors?.length) {
        // express-validator reports which field failed — put the message there
        // rather than raising a dialog that says only "Validation failed".
        const errors: Record<string, string> = {};
        for (const err of data.errors) {
          const field = err.path || err.param;
          if (field && !errors[field]) errors[field] = err.msg;
        }
        setFieldErrors(errors);
        document.getElementById(`signup-${FIELD_INPUT_IDS[Object.keys(errors)[0]]}`)?.focus();
      } else if (response.status === 409) {
        setSignUpError({
          kind: "existingAccount",
          message: data.message || 'An account already exists with this email.',
        });
      } else {
        setSignUpError({
          kind: "generic",
          message: data.message || 'Failed to send OTP. Please try again.',
        });
      }
    } catch (error) {
      setSignUpError({
        kind: "generic",
        message: 'We could not reach the server. Please check your connection and try again.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Carry the email over to the Sign In tab so the user only types a password.
  const handleGoToSignIn = () => {
    setSignUpError(null);
    setFormData((prev) => ({ ...prev, password: "" }));
    setActiveTab("signin");
  };

  const handleUseDifferentEmail = () => {
    setSignUpError(null);
    setFormData((prev) => ({ ...prev, email: "" }));
    document.getElementById("signup-email")?.focus();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;

    setFormData((prev) => ({ ...prev, [name]: value }));

    // Clear the message as soon as they start fixing that field.
    setFieldErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  // Sign-up inputs share one set of classes; only the border colour changes
  // when the field is in error.
  const signUpInputClass = (field: string, extra = "") =>
    [
      "h-10 bg-card",
      extra,
      fieldErrors[field] ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/15" : "",
    ].join(" ");

  const renderFieldError = (field: string) =>
    fieldErrors[field] ? (
      <p id={`signup-${FIELD_INPUT_IDS[field]}-error`} className="text-xs font-medium text-destructive">
        {fieldErrors[field]}
      </p>
    ) : null;

  const handleBackToSignup = () => {
    setShowOTPVerification(false);
  };

  // Show OTP verification component if needed
  if (showOTPVerification) {
    return (
      <OTPVerification
        email={formData.email}
        fullName={formData.fullName}
        phone={formData.phone}
        companyName={formData.companyName}
        password={formData.password}
        onBack={handleBackToSignup}
      />
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  const labelClass = "text-[13px] font-medium text-foreground";
  const inputClass = "h-10 bg-card";
  const eyeButtonClass =
    "absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 p-0 text-muted-foreground hover:text-foreground";

  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] bg-background">
      {/* Brand panel */}
      <aside className="relative hidden overflow-hidden bg-slate-950 text-white lg:flex lg:flex-col">
        {/* crop-mark grid, like the corner of a press sheet */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.07]" aria-hidden>
          <defs>
            <pattern id="crop" width="96" height="96" patternUnits="userSpaceOnUse">
              <path d="M0 12 H8 M12 0 V8 M96 84 H88 M84 96 V88" stroke="white" strokeWidth="1" />
              <circle cx="48" cy="48" r="6" fill="none" stroke="white" strokeWidth="1" />
              <path d="M48 38 V58 M38 48 H58" stroke="white" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#crop)" />
        </svg>
        <div className="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-sky-500/20 blur-3xl" aria-hidden />
        <div className="absolute -bottom-40 -left-24 h-96 w-96 rounded-full bg-fuchsia-600/10 blur-3xl" aria-hidden />

        <div className="relative flex flex-1 flex-col justify-between p-10 xl:p-14">
          <BrandLogo tone="light" />

          <div className="max-w-lg">
            <p className="section-label !text-sky-300">Built for printers</p>
            <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight xl:text-[40px]">
              Run your print shop from estimate to dispatch.
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-slate-300">
              One system for offset, digital and large-format work — quoting, job tickets, the production floor,
              paper stock and GST billing.
            </p>

            <ul className="mt-10 space-y-5">
              {[
                { icon: Calculator, title: "Accurate estimates", text: "Imposition, paper, plates, press and finishing priced in seconds." },
                { icon: SquareKanban, title: "Live production board", text: "Every job ticket from pre-press through press to dispatch." },
                { icon: Layers, title: "Paper & ink stock", text: "GSM-wise stock, purchase bills and supplier ledgers." },
                { icon: FileText, title: "GST billing & follow-ups", text: "Invoices, payment reminders and WhatsApp updates." },
              ].map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex gap-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] ring-1 ring-white/10">
                    <Icon className="h-[18px] w-[18px] text-sky-300" />
                  </span>
                  <div>
                    <div className="text-sm font-medium">{title}</div>
                    <div className="text-sm text-slate-400">{text}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="cmyk-strip h-1 w-12 rounded-full" aria-hidden />
            Cyan · Magenta · Yellow · Key
          </div>
        </div>
      </aside>

      {/* Form panel */}
      <main className="flex flex-col">
        <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8">
          <div className="w-full max-w-[400px]">
            <BrandLogo className="mb-10 lg:hidden" />

            <h2 className="text-2xl font-semibold tracking-tight">
              {activeTab === "signin" ? "Sign in to your workspace" : "Create your workspace"}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {activeTab === "signin"
                ? "Welcome back. Enter your details to continue."
                : "Set up Terralabs ERP for your print business."}
            </p>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-8 w-full">
              <TabsList className="grid h-10 w-full grid-cols-2">
                <TabsTrigger value="signin" className="h-full">Sign in</TabsTrigger>
                <TabsTrigger value="signup" className="h-full">Create account</TabsTrigger>
              </TabsList>

              <TabsContent value="signin" className="mt-6">
                <form onSubmit={handleSignIn} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="signin-email" className={labelClass}>Email</Label>
                    <Input
                      id="signin-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@yourpress.com"
                      value={formData.email}
                      onChange={handleInputChange}
                      required
                      className={inputClass}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="signin-password" className={labelClass}>Password</Label>
                    <div className="relative">
                      <Input
                        id="signin-password"
                        name="password"
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        placeholder="Enter your password"
                        value={formData.password}
                        onChange={handleInputChange}
                        required
                        className={`${inputClass} pr-10`}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={eyeButtonClass}
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                  <Button type="submit" className="h-10 w-full" disabled={isLoading}>
                    {isLoading ? "Signing in…" : "Sign in"}
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="signup" className="mt-6">
                <form onSubmit={handleSignUp} className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="signup-name" className={labelClass}>Full name</Label>
                      <Input
                        id="signup-name"
                        name="fullName"
                        type="text"
                        autoComplete="name"
                        placeholder="Your name"
                        value={formData.fullName}
                        onChange={handleInputChange}
                        required
                        aria-invalid={!!fieldErrors.fullName}
                        aria-describedby={fieldErrors.fullName ? "signup-name-error" : undefined}
                        className={signUpInputClass("fullName")}
                      />
                      {renderFieldError("fullName")}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="signup-phone" className={labelClass}>
                        Phone <span className="font-normal text-muted-foreground">(optional)</span>
                      </Label>
                      <Input
                        id="signup-phone"
                        name="phone"
                        type="tel"
                        autoComplete="tel"
                        placeholder="+91 98765 43210"
                        value={formData.phone}
                        onChange={handleInputChange}
                        aria-invalid={!!fieldErrors.phone}
                        aria-describedby={fieldErrors.phone ? "signup-phone-error" : undefined}
                        className={signUpInputClass("phone")}
                      />
                      {renderFieldError("phone")}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-company" className={labelClass}>
                      Press / company name <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id="signup-company"
                      name="companyName"
                      type="text"
                      autoComplete="organization"
                      placeholder="e.g. Sri Lakshmi Offset Printers"
                      value={formData.companyName}
                      onChange={handleInputChange}
                      aria-invalid={!!fieldErrors.companyName}
                      aria-describedby={fieldErrors.companyName ? "signup-company-error" : undefined}
                      className={signUpInputClass("companyName")}
                    />
                    {renderFieldError("companyName")}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-email" className={labelClass}>Work email</Label>
                    <Input
                      id="signup-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@yourpress.com"
                      value={formData.email}
                      onChange={handleInputChange}
                      required
                      aria-invalid={!!fieldErrors.email}
                      aria-describedby={fieldErrors.email ? "signup-email-error" : undefined}
                      className={signUpInputClass("email")}
                    />
                    {renderFieldError("email")}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-password" className={labelClass}>Password</Label>
                    <div className="relative">
                      <Input
                        id="signup-password"
                        name="password"
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        placeholder="At least 6 characters"
                        value={formData.password}
                        onChange={handleInputChange}
                        required
                        minLength={6}
                        aria-invalid={!!fieldErrors.password}
                        aria-describedby={fieldErrors.password ? "signup-password-error" : undefined}
                        className={signUpInputClass("password", "pr-10")}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={eyeButtonClass}
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                    {renderFieldError("password")}
                  </div>
                  <Button type="submit" className="h-10 w-full" disabled={isLoading}>
                    {isLoading ? "Sending verification code…" : "Create account"}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    We'll email you a one-time code to verify your address.
                  </p>
                </form>
              </TabsContent>
            </Tabs>
          </div>
        </div>

        {/* Sign-up error dialog */}
        <Dialog open={!!signUpError} onOpenChange={(open) => !open && setSignUpError(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader className="space-y-3">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                {signUpError?.kind === "existingAccount" ? (
                  <UserCheck className="h-6 w-6 text-primary" />
                ) : (
                  <AlertCircle className="h-6 w-6 text-destructive" />
                )}
              </div>
              <DialogTitle className="text-center text-lg font-semibold">
                {signUpError?.kind === "existingAccount"
                  ? "Account already exists"
                  : "Sign up failed"}
              </DialogTitle>
              <DialogDescription className="text-center">
                {signUpError?.kind === "existingAccount" ? (
                  <>
                    <span className="font-medium text-foreground">{formData.email}</span> is already
                    registered. Please sign in with this account instead.
                  </>
                ) : (
                  signUpError?.message
                )}
              </DialogDescription>
            </DialogHeader>

            <DialogFooter className="mt-2 gap-2">
              {signUpError?.kind === "existingAccount" ? (
                <>
                  <Button type="button" variant="outline" onClick={handleUseDifferentEmail} className="flex-1">
                    Use another email
                  </Button>
                  <Button type="button" onClick={handleGoToSignIn} className="flex-1">
                    Sign in instead
                  </Button>
                </>
              ) : (
                <Button type="button" onClick={() => setSignUpError(null)} className="w-full">
                  Try again
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Footer */}
        <footer className="border-t px-5 py-4 sm:px-8">
          <div className="mx-auto flex max-w-[400px] flex-col items-center gap-2 text-xs text-muted-foreground sm:max-w-none sm:flex-row sm:justify-between">
            <p>© 2026 Synx Automation Private Limited. All rights reserved.</p>
            <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              <Link to="/terms-and-conditions" className="hover:text-foreground hover:underline underline-offset-2">Terms</Link>
              <Link to="/privacy-policy" className="hover:text-foreground hover:underline underline-offset-2">Privacy</Link>
              <Link to="/data-security-policy" className="hover:text-foreground hover:underline underline-offset-2">Data security</Link>
            </nav>
          </div>
        </footer>
      </main>
    </div>
  );
}
