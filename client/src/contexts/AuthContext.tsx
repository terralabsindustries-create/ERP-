import React, { createContext, useContext, useEffect, useState } from 'react';
import apiClient, { ApiResponse } from '@/lib/apiClient';
import { useToast } from '@/hooks/use-toast';
import { SubscriptionModal } from '@/components/subscription/SubscriptionModal';

interface User {
  id: string;
  email: string;
  fullName: string;
  phone?: string;
  role: string;
  companyName?: string;
  preferences: any;
  permissions?: string[]; // Array of permission strings
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
  showSubscriptionModal: boolean;
  setShowSubscriptionModal: (show: boolean) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const { toast } = useToast();

  // Check subscription status and show modal if needed
  const checkSubscriptionStatus = (userData: User) => {
    // Show modal if subscription is undefined, null, or inactive
    if (!userData.subscription || userData.subscription.isActive === false) {
      setShowSubscriptionModal(true);
    }
  };

  // Determine if modal can be closed (only if subscription is active)
  const canCloseModal = user?.subscription?.isActive !== false;

  useEffect(() => {
    // Check for existing token and user
    const checkAuthStatus = async () => {
      try {
        const token = localStorage.getItem('token');
        if (token) {
          const userData = await apiClient.getCurrentUser();
          setUser(userData);
          setSession({ user: userData });
          checkSubscriptionStatus(userData);
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

  const signIn = async (email: string, password: string) => {
    try {
      const response = await apiClient.login(email, password);
      
      console.log(' AuthContext signIn response:', response);
      console.log('🔑 AuthContext signIn response:', response);
      
      setUser(response.user);
      setSession({ user: response.user });
      checkSubscriptionStatus(response.user);
      
      console.log('🔑 User set in AuthContext:', response.user);
      
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
        description: "Welcome to Print Arts Management System.",
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

  const hasPermission = (permission: string): boolean => {
    // Admin has full access to everything
    if (user?.role === 'admin') {
      return true;
    }
    // Staff and Manager: check if user has the specific permission
    return user?.permissions?.includes(permission) || false;
  };

  const value = {
    user,
    session,
    loading,
    signIn,
    signUp,
    signOut,
    hasPermission,
    showSubscriptionModal,
    setShowSubscriptionModal,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
      <SubscriptionModal 
        open={showSubscriptionModal} 
        onClose={() => setShowSubscriptionModal(false)}
        userPlan={user?.subscription?.plan}
        canClose={canCloseModal}
      />
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