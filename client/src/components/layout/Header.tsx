import { useState, useEffect, useRef } from "react";
import { Bell, Search, User, Users, Briefcase, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import apiClient from "@/lib/apiClient";
import { useNavigate } from "react-router-dom";

interface Notification {
  id: string;
  title: string;
  description: string;
  type: string;
  variant: "destructive" | "warning" | "pending" | "success";
}

interface CustomerSearchResult {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
}

interface JobSearchResult {
  id: string;
  title: string;
  customerId?: { name?: string } | null;
}

interface InvoiceSearchResult {
  id: string;
  invoiceNumber: string;
  customerId?: { name?: string } | null;
}

interface SearchResults {
  customers: CustomerSearchResult[];
  jobs: JobSearchResult[];
  invoices: InvoiceSearchResult[];
}

const EMPTY_SEARCH_RESULTS: SearchResults = { customers: [], jobs: [], invoices: [] };

export function Header() {
  const { user, signOut, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResults>(EMPTY_SEARCH_RESULTS);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchNotifications();
  }, []);

  const fetchNotifications = async () => {
    try {
      // TODO: Implement notifications API endpoint
      console.warn('Notifications API not yet implemented - using placeholder data');
      setNotifications([]);
    } catch (error) {
      console.error('Error fetching notifications:', error);
    }
  };

  useEffect(() => {
    const term = searchQuery.trim();
    if (!term) {
      setSearchResults(EMPTY_SEARCH_RESULTS);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    const timeoutId = setTimeout(async () => {
      const [customersRes, jobsRes, invoicesRes] = await Promise.allSettled([
        apiClient.getCustomer({ search: term, limit: 5 }) as Promise<{ customers: CustomerSearchResult[] }>,
        apiClient.getJobs({ search: term, limit: 5 }) as Promise<{ jobs: JobSearchResult[] }>,
        apiClient.getInvoices({ search: term, limit: 5 }) as Promise<{ invoices: InvoiceSearchResult[] }>,
      ]);

      setSearchResults({
        customers: customersRes.status === "fulfilled" ? customersRes.value?.customers || [] : [],
        jobs: jobsRes.status === "fulfilled" ? jobsRes.value?.jobs || [] : [],
        invoices: invoicesRes.status === "fulfilled" ? invoicesRes.value?.invoices || [] : [],
      });
      setSearchLoading(false);
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const hasSearchResults =
    searchResults.customers.length > 0 || searchResults.jobs.length > 0 || searchResults.invoices.length > 0;

  const goToSearchResult = (path: string, term: string) => {
    navigate(`${path}?q=${encodeURIComponent(term)}`);
    setSearchOpen(false);
    setSearchQuery("");
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setSearchOpen(false);
      (event.target as HTMLInputElement).blur();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (searchResults.customers[0]) {
        goToSearchResult("/customers", searchResults.customers[0].name);
      } else if (searchResults.jobs[0]) {
        goToSearchResult("/jobs", searchResults.jobs[0].title);
      } else if (searchResults.invoices[0]) {
        goToSearchResult("/invoices", searchResults.invoices[0].invoiceNumber);
      }
    }
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center justify-between px-6">
        <div className="flex items-center space-x-6">
          <SidebarTrigger className="hover:bg-muted rounded-lg p-2 transition-colors md:hidden" />
          <div className="relative max-w-sm" ref={searchContainerRef}>
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search customers, jobs, invoices..."
              className="pl-10 w-64 bg-muted/50 border-0 focus:bg-background"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => searchQuery.trim() && setSearchOpen(true)}
              onKeyDown={handleSearchKeyDown}
            />

            {searchOpen && searchQuery.trim() && (
              <div className="absolute left-0 top-full z-50 mt-2 w-80 rounded-md border border-border bg-popover shadow-lg">
                {searchLoading ? (
                  <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Searching...
                  </div>
                ) : hasSearchResults ? (
                  <div className="max-h-96 overflow-y-auto py-2">
                    {searchResults.customers.length > 0 && (
                      <div className="px-2 pb-1">
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Customers</p>
                        {searchResults.customers.map((customer) => (
                          <button
                            key={customer.id}
                            type="button"
                            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                            onClick={() => goToSearchResult("/customers", customer.name)}
                          >
                            <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{customer.name}</div>
                              {(customer.phone || customer.email) && (
                                <div className="truncate text-xs text-muted-foreground">
                                  {customer.phone || customer.email}
                                </div>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    {searchResults.jobs.length > 0 && (
                      <div className="px-2 pb-1">
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Jobs</p>
                        {searchResults.jobs.map((job) => (
                          <button
                            key={job.id}
                            type="button"
                            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                            onClick={() => goToSearchResult("/jobs", job.title)}
                          >
                            <Briefcase className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{job.title}</div>
                              {job.customerId?.name && (
                                <div className="truncate text-xs text-muted-foreground">{job.customerId.name}</div>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    {searchResults.invoices.length > 0 && (
                      <div className="px-2 pb-1">
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Invoices</p>
                        {searchResults.invoices.map((invoice) => (
                          <button
                            key={invoice.id}
                            type="button"
                            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                            onClick={() => goToSearchResult("/invoices", invoice.invoiceNumber)}
                          >
                            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{invoice.invoiceNumber}</div>
                              {invoice.customerId?.name && (
                                <div className="truncate text-xs text-muted-foreground">{invoice.customerId.name}</div>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    No results for "{searchQuery}"
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center space-x-4">
          {/* Notifications */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="relative">
                <Bell className="h-5 w-5" />
                {notifications.length > 0 && (
                  <Badge
                    variant="destructive"
                    className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0 text-xs"
                  >
                    {notifications.length}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel>Notifications</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {notifications.length === 0 ? (
                <DropdownMenuItem className="p-4 text-center text-muted-foreground">
                  No new notifications
                </DropdownMenuItem>
              ) : (
                notifications.map((notification) => (
                  <DropdownMenuItem key={notification.id} className="flex flex-col items-start p-4">
                    <div className="flex w-full items-center justify-between">
                      <span className="font-medium">{notification.title}</span>
                      <Badge variant={notification.variant}>
                        {notification.type === 'job' ? 'Urgent' : 
                         notification.type === 'stock' ? 'Warning' : 'Pending'}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      {notification.description}
                    </p>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* User Profile */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <User className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                {user?.email || "My Account"}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {hasPermission("Settings") && (
                <DropdownMenuItem onClick={() => navigate('/settings')}>
                  Settings
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => navigate('/create-login')}>
                User Management
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/activity-log')}>
                Activity Log
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem 
                className="text-destructive"
                onClick={() => signOut()}
              >
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}