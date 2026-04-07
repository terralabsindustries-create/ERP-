import { useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Building2, Eye, EyeOff, Shield, Users, BarChart3 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { OTPVerification } from "@/components/auth/OTPVerification";
import logo from "../assets/logo.png";

export default function Auth() {
  const { user, signIn, signUp, loading } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showOTPVerification, setShowOTPVerification] = useState(false);
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
    setIsLoading(true);
    
    try {
      const response = await fetch('http://localhost:4001/api/auth/send-otp', {
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
      } else {
        // Show error message from server
        alert(data.message || 'Failed to send OTP');
      }
    } catch (error) {
      alert('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

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
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-orange-400"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen max-h-screen flex flex-col bg-white overflow-hidden">
      {/* Premium Background */}
      <div className="absolute inset-0 bg-gradient-to-br from-orange-50 via-white to-orange-50" />
      <div className="absolute inset-0 bg-grid-orange-100/[0.03] bg-[size:120px_120px]" />
      
      {/* Background Accents */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-orange-200/8 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-orange-300/8 rounded-full blur-3xl" />
      </div>

      {/* Main Content - Perfectly Centered */}
      <div className="relative z-10 flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-5xl">
          <div className="grid lg:grid-cols-2 gap-8 lg:gap-16 items-center">
            
            {/* Left Side - Branding */}
            <div className="hidden lg:flex flex-col justify-center">
              <div className="space-y-6">
                <div className="flex items-center justify-start">
                  <div className="p-3 bg-gradient-to-r from-orange-100 to-orange-200 rounded-2xl shadow-lg">
                    <Building2 className="h-8 w-8 text-orange-600" />
                  </div>
                </div>
                <div className="space-y-4">
                  <h1 className="text-5xl font-bold bg-gradient-to-r from-gray-900 via-orange-600 to-gray-900 bg-clip-text text-transparent leading-tight">
                    SerpY ERP
                  </h1>
                  <p className="text-xl text-gray-600 font-medium">
                    Enterprise Resource Planning System
                  </p>
                  <p className="text-gray-500 text-lg leading-relaxed">
                    Transform your business operations with intelligent automation,
                    real-time insights, and seamless workflow management.
                  </p>
                </div>
              </div>

              {/* Feature Cards */}
              <div className="grid grid-cols-1 gap-4 mt-8">
                <div className="flex items-center space-x-4 p-4 bg-white/60 backdrop-blur-sm rounded-xl border border-orange-100/50 shadow-sm">
                  <div className="p-3 bg-gradient-to-r from-orange-100 to-orange-200 rounded-xl flex-shrink-0">
                    <Users className="h-6 w-6 text-orange-600" />
                  </div>
                  <div className="text-left">
                    <h3 className="font-semibold text-gray-800 text-base">
                      Team Collaboration
                    </h3>
                    <p className="text-sm text-gray-600">
                      Work together seamlessly
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-4 p-4 bg-white/60 backdrop-blur-sm rounded-xl border border-orange-100/50 shadow-sm">
                  <div className="p-3 bg-gradient-to-r from-orange-100 to-orange-200 rounded-xl flex-shrink-0">
                    <BarChart3 className="h-6 w-6 text-orange-600" />
                  </div>
                  <div className="text-left">
                    <h3 className="font-semibold text-gray-800 text-base">
                      Real-time Analytics
                    </h3>
                    <p className="text-sm text-gray-600">Data-driven decisions</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Side - Login Form */}
            <div className="flex justify-center">
              <Card className="w-full max-w-md border-0 shadow-2xl bg-white/95 backdrop-blur-sm">
                <CardHeader className="text-center pb-6 pt-8">
                  <div className="lg:hidden flex justify-center mb-6 p-3 bg-gradient-to-r from-orange-100 to-orange-200 rounded-2xl shadow-lg">
                    <Building2 className="h-8 w-8 text-orange-600" />
                  </div>
                  <CardTitle className="text-2xl font-bold text-gray-800 mb-2">
                    Welcome Back
                  </CardTitle>
                  <p className="text-gray-600">
                    Sign in to access your ERP dashboard
                  </p>
                </CardHeader>
                <CardContent className="px-8 pb-8">
                  <Tabs defaultValue="signin" className="w-full">
                    <TabsList className="grid w-full grid-cols-2 mb-6 bg-gradient-to-r from-orange-50 to-orange-100/50 backdrop-blur-xl p-1.5 rounded-2xl border border-orange-200/30">
                      <TabsTrigger
                        value="signin"
                        className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-orange-200/60 data-[state=active]:to-orange-300/60 data-[state=active]:shadow-xl text-gray-600 data-[state=active]:text-gray-900 font-semibold rounded-xl transition-all duration-500"
                      >
                        Sign In
                      </TabsTrigger>
                      <TabsTrigger
                        value="signup"
                        className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-orange-200/60 data-[state=active]:to-orange-300/60 data-[state=active]:shadow-xl text-gray-600 data-[state=active]:text-gray-900 font-semibold rounded-xl transition-all duration-500"
                      >
                        Sign Up
                      </TabsTrigger>
                    </TabsList>

                  <TabsContent value="signin" className="space-y-5">
                    <form onSubmit={handleSignIn} className="space-y-5">
                      <div className="space-y-4">
                        <Label
                          htmlFor="signin-email"
                          className="text-sm font-semibold text-gray-700 uppercase tracking-wide"
                        >
                          Email Address
                        </Label>
                        <Input
                          id="signin-email"
                          name="email"
                          type="email"
                          placeholder="john@enterprise.com"
                          value={formData.email}
                          onChange={handleInputChange}
                          required
                          className="h-14 bg-white/80 border-orange-200/50 text-gray-900 placeholder-gray-500/50 focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20 backdrop-blur-xl rounded-2xl px-6 text-lg transition-all duration-300"
                        />
                      </div>
                      <div className="space-y-4">
                        <Label
                          htmlFor="signin-password"
                          className="text-sm font-semibold text-gray-700 uppercase tracking-wide"
                        >
                          Password
                        </Label>
                        <div className="relative">
                          <Input
                            id="signin-password"
                            name="password"
                            type={showPassword ? "text" : "password"}
                            placeholder="Enter your secure password"
                            value={formData.password}
                            onChange={handleInputChange}
                            required
                            className="h-14 bg-white/80 border-orange-200/50 text-gray-900 placeholder-gray-500/50 focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20 pr-14 backdrop-blur-xl rounded-2xl px-6 text-lg transition-all duration-300"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="absolute right-2 top-1/2 transform -translate-y-1/2 h-10 w-10 hover:bg-orange-100/50 text-gray-400 hover:text-gray-600 rounded-xl transition-all duration-300"
                            onClick={() => setShowPassword(!showPassword)}
                          >
                            {showPassword ? (
                              <EyeOff className="h-5 w-5" />
                            ) : (
                              <Eye className="h-5 w-5" />
                            )}
                          </Button>
                        </div>
                      </div>
                      <Button
                        type="submit"
                        className="w-full h-14 bg-gradient-to-r from-orange-500 via-orange-600 to-orange-700 hover:from-orange-600 hover:via-orange-700 hover:to-orange-800 font-bold text-white text-lg rounded-2xl shadow-2xl hover:shadow-orange-500/25 transition-all duration-500 transform hover:scale-[1.02] tracking-wide"
                        disabled={isLoading}
                      >
                        {isLoading
                          ? "Authenticating..."
                          : "Sign In to Enterprise Portal"}
                      </Button>
                    </form>
                  </TabsContent>

                  <TabsContent value="signup" className="space-y-5">
                    <form onSubmit={handleSignUp} className="space-y-5">
                      <div className="space-y-4">
                        <Label
                          htmlFor="signup-name"
                          className="text-sm font-semibold text-gray-700 uppercase tracking-wide"
                        >
                          Full Name
                        </Label>
                        <Input
                          id="signup-name"
                          name="fullName"
                          type="text"
                          placeholder="John Anderson"
                          value={formData.fullName}
                          onChange={handleInputChange}
                          required
                          className="h-14 bg-white/80 border-orange-200/50 text-gray-900 placeholder-gray-500/50 focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20 backdrop-blur-xl rounded-2xl px-6 text-lg transition-all duration-300"
                        />
                      </div>
                      <div className="space-y-4">
                        <Label
                          htmlFor="signup-email"
                          className="text-sm font-semibold text-gray-700 uppercase tracking-wide"
                        >
                          Email Address
                        </Label>
                        <Input
                          id="signup-email"
                          name="email"
                          type="email"
                          placeholder="john@enterprise.com"
                          value={formData.email}
                          onChange={handleInputChange}
                          required
                          className="h-14 bg-white/80 border-orange-200/50 text-gray-900 placeholder-gray-500/50 focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20 backdrop-blur-xl rounded-2xl px-6 text-lg transition-all duration-300"
                        />
                      </div>
                      <div className="space-y-4">
                        <Label
                          htmlFor="signup-password"
                          className="text-sm font-semibold text-gray-700 uppercase tracking-wide"
                        >
                          Password
                        </Label>
                        <div className="relative">
                          <Input
                            id="signup-password"
                            name="password"
                            type={showPassword ? "text" : "password"}
                            placeholder="Create a strong password"
                            value={formData.password}
                            onChange={handleInputChange}
                            required
                            minLength={6}
                            className="h-14 bg-white/80 border-orange-200/50 text-gray-900 placeholder-gray-500/50 focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20 pr-14 backdrop-blur-xl rounded-2xl px-6 text-lg transition-all duration-300"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="absolute right-2 top-1/2 transform -translate-y-1/2 h-10 w-10 hover:bg-orange-100/50 text-gray-400 hover:text-gray-600 rounded-xl transition-all duration-300"
                            onClick={() => setShowPassword(!showPassword)}
                          >
                            {showPassword ? (
                              <EyeOff className="h-5 w-5" />
                            ) : (
                              <Eye className="h-5 w-5" />
                            )}
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-4">
                        <Label
                          htmlFor="signup-phone"
                          className="text-sm font-semibold text-gray-700 uppercase tracking-wide"
                        >
                          Phone Number (Optional)
                        </Label>
                        <Input
                          id="signup-phone"
                          name="phone"
                          type="tel"
                          placeholder="+1 234 567 8900"
                          value={formData.phone}
                          onChange={handleInputChange}
                          className="h-14 bg-white/80 border-orange-200/50 text-gray-900 placeholder-gray-500/50 focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20 backdrop-blur-xl rounded-2xl px-6 text-lg transition-all duration-300"
                        />
                      </div>
                      <div className="space-y-4">
                        <Label
                          htmlFor="signup-company"
                          className="text-sm font-semibold text-gray-700 uppercase tracking-wide"
                        >
                          Company Name (Optional)
                        </Label>
                        <Input
                          id="signup-company"
                          name="companyName"
                          type="text"
                          placeholder="Acme Corporation"
                          value={formData.companyName}
                          onChange={handleInputChange}
                          className="h-14 bg-white/80 border-orange-200/50 text-gray-900 placeholder-gray-500/50 focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20 backdrop-blur-xl rounded-2xl px-6 text-lg transition-all duration-300"
                        />
                      </div>
                      <Button
                        type="submit"
                        className="w-full h-14 bg-gradient-to-r from-orange-500 via-orange-600 to-orange-700 hover:from-orange-600 hover:via-orange-700 hover:to-orange-800 font-bold text-white text-lg rounded-2xl shadow-2xl hover:shadow-orange-500/25 transition-all duration-500 transform hover:scale-[1.02] tracking-wide"
                        disabled={isLoading}
                      >
                        {isLoading
                          ? "Sending OTP..."
                          : "Send Verification Code"}
                      </Button>
                    </form>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Mobile Branding */}
        <div className="lg:hidden text-center mb-4">
          <div className="flex justify-center mb-4 p-3 bg-gradient-to-r from-orange-100 to-orange-200 rounded-2xl shadow-lg">
            <Building2 className="h-8 w-8 text-orange-600" />
          </div>
          <h2 className="text-2xl font-bold text-slate-800 mb-2">SerpY ERP</h2>
          <p className="text-slate-600">Enterprise Resource Planning System</p>
        </div>

        {/* Footer */}
        <div className="relative z-10 pt-16 pb-4 px-4">
          <div className="text-center space-y-2">
            <p className="text-xs text-gray-600 font-medium">
              © 2026 Synx Automation Private Limited. All rights reserved.
            </p>
            <div className="flex flex-wrap justify-center items-center gap-3 text-xs">
              <Link
                to="/terms-and-conditions"
                className="text-gray-600 hover:text-orange-600 transition-colors duration-200 font-medium hover:underline underline-offset-2"
              >
                Terms & Conditions
              </Link>
              <span className="text-gray-300">•</span>
              <Link
                to="/privacy-policy"
                className="text-gray-600 hover:text-orange-600 transition-colors duration-200 font-medium hover:underline underline-offset-2"
              >
                Privacy Policy
              </Link>
              <span className="text-gray-300">•</span>
              <Link
                to="/data-security-policy"
                className="text-gray-600 hover:text-orange-600 transition-colors duration-200 font-medium hover:underline underline-offset-2"
              >
                Data Security Policy
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  );
}
