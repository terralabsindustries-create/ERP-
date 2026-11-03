import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import apiClient, { ApiResponse } from '@/lib/apiClient';
import { useToast } from '@/hooks/use-toast';

interface User {
  id: string;
  email: string;
  fullName: string;
  phone?: string;
  role: string;
  companyName?: string;
  preferences: any;
  permissions?: string[]; // Array of permission strings
  canViewAllData?: boolean; // Sees every team member's invoices, not just their own
  accessRole?: string | null; // The named role their permissions come from (User Management → Roles)
  accessRoleName?: string | null;
  subscription?: {
    isActive: boolean;
    plan: string;
    startDate?: string;
    endDate?: string;
    autoRenew?: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

interface AuthContextType {
  user: User | null;
  session: any | null; // For compatibility, but not used with new backend
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: any }>;
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: any }>;
  signOut: () => Promise<void>;
  hasPermission: (permission: string) => boolean; // Check if user has a specific permission
  refreshUser: () => Promise<User | undefined>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    // Check for existing token and user
    const checkAuthStatus = async () => {
      try {
        const token = localStorage.getItem('token');
        if (token) {
          const userData = await apiClient.getCurrentUser();
          setUser(userData);
          setSession({ user: userData });
        }
      } catch (error) {
        // Token is invalid, clear it
        apiClient.clearToken();
      } finally {
        setLoading(false);
      }
    };

    checkAuthStatus();
  }, []);

  // apiClient fires this when the server answers 401 to a signed-in request
  // (expired token, deactivated or deleted login): drop the session so the
  // routes send the person back to the sign-in page.
  const signedInRef = useRef(false);
  useEffect(() => {
    signedInRef.current = !!user;
  }, [user]);
  useEffect(() => {
    const onExpired = () => {
      // Several requests can fail at once; tell the person only once.
      if (!signedInRef.current) return;
      signedInRef.current = false;
      setUser(null);
      setSession(null);
      toast({ title: "You've been signed out", description: "Your session ended. Please sign in again.", variant: "destructive" });
    };
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, [toast]);

  const signIn = async (email: string, password: string) => {
    try {
      const response = await apiClient.login(email, password);
      
      
      setUser(response.user);
      setSession({ user: response.user });
      
      
      toast({
        title: "Welcome back!",
        description: "You've been signed in successfully.",
      });

      return { error: null };
    } catch (error: any) {
      console.error('🔑 AuthContext signIn error:', error);
      toast({
        title: "Sign In Failed",
        description: error.message || "An unexpected error occurred.",
        variant: "destructive",
      });
      return { error };
    }
  };

  const signUp = async (email: string, password: string, fullName?: string) => {
    try {
      const response = await apiClient.register(email, password, fullName || '');
      
      setUser(response.user);
      setSession({ user: response });

      toast({
        title: "Account Created!",
        description: "Welcome to Carbon.",
      });

      return { error: null };
    } catch (error: any) {
      toast({
        title: "Sign Up Failed",
        description: error.message || "An unexpected error occurred.",
        variant: "destructive",
      });
      return { error };
    }
  };

  const signOut = async () => {
    try {
      await apiClient.logout();
      setUser(null);
      setSession(null);
      
      toast({
        title: "Signed out",
        description: "You've been signed out successfully.",
      });
    } catch (error) {
      // Even if logout fails on server, clear local state
      setUser(null);
      setSession(null);
      apiClient.clearToken();
      
      toast({
        title: "Signed out",
        description: "You've been signed out successfully.",
      });
    }
  };

  /**
   * Works for both a MODULE ("Customers") and an ACTION ("Customers: Delete").
   * Mirrors backend/src/middleware/requirePermission.js exactly — keep the two
   * in step or the UI will offer buttons the API rejects.
   */
  const hasPermission = (permission: string): boolean => {
    // Admin has full access to everything
    if (user?.role === 'admin') {
      return true;
    }

    const granted = user?.permissions || [];
    const sep = permission.indexOf(': ');
    const module = sep === -1 ? permission : permission.slice(0, sep);

    if (!granted.includes(module)) return false;
    if (sep === -1) return true;

    // Logins created before granular actions existed have a module grant and no
    // actions — they keep full access to that module until they are re-saved.
    const hasAnyActionForModule = granted.some((p) => p.startsWith(`${module}: `));
    if (!hasAnyActionForModule) return true;

    return granted.includes(permission);
  };

  // Re-fetch the current user (e.g. right after signup) so the app treats
  // them as signed in.
  const refreshUser = async () => {
    try {
      const userData = await apiClient.getCurrentUser();
      setUser(userData);
      setSession({ user: userData });
      return userData;
    } catch (error) {
      console.error('Failed to refresh user:', error);
    }
  };

  const value = {
    user,
    session,
    loading,
    signIn,
    signUp,
    signOut,
    hasPermission,
    refreshUser,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}