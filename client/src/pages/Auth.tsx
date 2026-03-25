import { useState } from "react";
import { Navigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Building2, Eye, EyeOff, Shield, Users, BarChart3 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

export default function Auth() {
  const { user, signIn, signUp, loading } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    fullName: "",
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
    await signUp(formData.email, formData.password, formData.fullName);
    setIsLoading(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-orange-400"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white p-4">
      {/* Premium Background */}
      <div className="absolute inset-0 bg-gradient-to-br from-white via-orange-50 to-white" />
      
      {/* Subtle Grid Pattern */}
      <div className="absolute inset-0 bg-grid-orange-100/[0.05] bg-[size:100px_100px]" />
      
      {/* Sophisticated Background Accents */}
      <div className="absolute top-0 left-0 w-full h-full">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-orange-200/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-orange-300/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-gradient-to-r from-orange-200/8 to-orange-300/8 rounded-full blur-3xl" />
      </div>
      <div className="relative z-10 w-full max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-8 items-center">
          {/* Left Side - Branding */}
          <div className="hidden lg:block text-center lg:text-left">
            <div className="mb-8">
              <div className="inline-flex items-center justify-center mb-6 p-1 bg-white rounded-full shadow-lg">
                <img src="/src/assets/logo.png" alt="SerpY ERP Logo" className="h-16 w-16 rounded-full object-cover" />
              </div>
              <h1 className="text-5xl font-bold bg-gradient-to-r from-gray-900 via-orange-600 to-gray-900 bg-clip-text text-transparent mb-4">
                SerpY ERP
              </h1>
              <p className="text-xl text-gray-600 font-medium mb-2">
                Enterprise Resource Planning System
              </p>
              <p className="text-gray-500 text-lg leading-relaxed">
                Transform your business operations with intelligent automation, 
                real-time insights, and seamless workflow management.
              </p>
            </div>
            
            {/* Premium Feature Highlights */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-4">
              <div className="flex items-center space-x-3 p-3 bg-white/50 backdrop-blur-sm rounded-lg border border-white/20">
                <div className="p-2 bg-orange-100 rounded-lg">
                  <Users className="h-5 w-5 text-orange-600" />
                </div>
                <div className="text-left">
                  <h3 className="font-semibold text-gray-800">Team Collaboration</h3>
                  <p className="text-sm text-gray-600">Work together seamlessly</p>
                </div>
              </div>
              <div className="flex items-center space-x-3 p-3 bg-white/50 backdrop-blur-sm rounded-lg border border-white/20">
                <div className="p-2 bg-orange-100 rounded-lg">
                  <BarChart3 className="h-5 w-5 text-orange-600" />
                </div>
                <div className="text-left">
                  <h3 className="font-semibold text-gray-800">Real-time Analytics</h3>
                  <p className="text-sm text-gray-600">Data-driven decisions</p>
                </div>
              </div>
            </div>
          </div>
          
          {/* Right Side - Login Form */}
          <div className="flex justify-center">
            <Card className="w-full max-w-md border-0 shadow-2xl bg-white/95 backdrop-blur-sm">
              <CardHeader className="text-center pb-6 pt-8">
                <div className="lg:hidden flex justify-center mb-6 p-1 bg-white rounded-full shadow-lg">
                  <img src="/src/assets/logo.png" alt="SerpY ERP Logo" className="h-14 w-14 rounded-full object-cover" />
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
                  <TabsList className="grid w-full grid-cols-2 mb-6 bg-orange-50/50 backdrop-blur-xl p-1.5 rounded-2xl border border-orange-200/30">
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
                        <Label htmlFor="signin-email" className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
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
                        <Label htmlFor="signin-password" className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
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
                        {isLoading ? "Authenticating..." : "Sign In to Enterprise Portal"}
                      </Button>
                    </form>
                  </TabsContent>

                  <TabsContent value="signup" className="space-y-5">
                    <form onSubmit={handleSignUp} className="space-y-5">
                      <div className="space-y-4">
                        <Label htmlFor="signup-name" className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
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
                        <Label htmlFor="signup-email" className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
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
                        <Label htmlFor="signup-password" className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
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
                      <Button 
                        type="submit" 
                        className="w-full h-14 bg-gradient-to-r from-orange-500 via-orange-600 to-orange-700 hover:from-orange-600 hover:via-orange-700 hover:to-orange-800 font-bold text-white text-lg rounded-2xl shadow-2xl hover:shadow-orange-500/25 transition-all duration-500 transform hover:scale-[1.02] tracking-wide" 
                        disabled={isLoading}
                      >
                        {isLoading ? "Creating Account..." : "Create Enterprise Account"}
                      </Button>
                    </form>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </div>
        
        {/* Mobile Branding */}
        <div className="lg:hidden text-center mt-8">
          <h2 className="text-2xl font-bold text-slate-800 mb-2">
            SerpY ERP
          </h2>
          <p className="text-slate-600">
            Enterprise Resource Planning System
          </p>
        </div>
      </div>
    </div>
  );
}