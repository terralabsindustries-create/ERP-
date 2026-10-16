import { useState, useEffect, useRef } from "react";
import { Search, Users, Briefcase, FileText, Loader2, Plus, ChevronRight, LogOut, Settings, ShieldCheck, History } from "lucide-react";
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
import { useAuth } from "@/contexts/AuthContext";
import apiClient from "@/lib/apiClient";
import { useLocation, useNavigate } from "react-router-dom";
import { findPage } from "./navigation";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationBell } from "./NotificationBell";
import { cn } from "@/lib/utils";

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
  const location = useLocation();
  const page = findPage(location.pathname);
  const canSearchCustomers = hasPermission("Customers");
  const canSearchJobs = hasPermission("Jobs");
  const canSearchInvoices = hasPermission("Invoicing");
  const canSearch = canSearchCustomers || canSearchJobs || canSearchInvoices;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const initials = (user?.fullName || user?.email || "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResults>(EMPTY_SEARCH_RESULTS);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canSearch) return;
    const term = searchQuery.trim();
    if (!term) {
      setSearchResults(EMPTY_SEARCH_RESULTS);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    let active = true;
    const timeoutId = setTimeout(async () => {
      const [customersRes, jobsRes, invoicesRes] = await Promise.allSettled([
        canSearchCustomers ? apiClient.getCustomer({ search: term, limit: 5 }) as Promise<{ customers: CustomerSearchResult[] }> : Promise.resolve({ customers: [] }),
        canSearchJobs ? apiClient.getJobs({ search: term, limit: 5 }) as Promise<{ jobs: JobSearchResult[] }> : Promise.resolve({ jobs: [] }),
        canSearchInvoices ? apiClient.getInvoices({ search: term, limit: 5 }) as Promise<{ invoices: InvoiceSearchResult[] }> : Promise.resolve({ invoices: [] }),
      ]);

      if (!active) return;
      setSearchResults({
        customers: customersRes.status === "fulfilled" ? customersRes.value?.customers || [] : [],
        jobs: jobsRes.status === "fulfilled" ? jobsRes.value?.jobs || [] : [],
        invoices: invoicesRes.status === "fulfilled" ? invoicesRes.value?.invoices || [] : [],
      });
      setSearchLoading(false);
    }, 300);

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, [searchQuery, canSearch, canSearchCustomers, canSearchJobs, canSearchInvoices]);

  useEffect(() => {
    if (!canSearch) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [canSearch]);

  useEffect(() => {
    if (!canSearch) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canSearch]);

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
    <header
      data-app-chrome
      className="sticky top-0 z-40 w-full shrink-0 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85"
    >
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4 md:px-6">
        <SidebarTrigger className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground" />
        <div className="hidden h-5 w-px bg-border md:block" />

        {/* Where am I */}
        <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm md:flex">
          <span className="whitespace-nowrap text-muted-foreground">{page?.group || "Terralabs ERP"}</span>
          {page && (
            <>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              <span className="truncate font-medium text-foreground" aria-current="page">{page.title}</span>
            </>
          )}
        </nav>

        <div className="flex min-w-0 flex-1 justify-end md:justify-center">
          {canSearch && (
            <div className="relative w-full max-w-md" ref={searchContainerRef} role="search">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="search"
              placeholder="Search your records…"
              aria-label="Search accessible customers, jobs and invoices"
              className="h-9 w-full border-transparent bg-muted/80 pl-9 pr-3 shadow-none hover:border-border focus-visible:bg-card sm:pr-12 dark:bg-muted/60"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => searchQuery.trim() && setSearchOpen(true)}
              onKeyDown={handleSearchKeyDown}
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block" aria-hidden>
              ⌘K
            </kbd>

            {searchOpen && searchQuery.trim() && (
              <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-lg border border-border bg-popover shadow-float">
                {searchLoading ? (
                  <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Searching…
                  </div>
                ) : hasSearchResults ? (
                  <div className="max-h-96 overflow-y-auto py-2">
                    {searchResults.customers.length > 0 && (
                      <div className="px-2 pb-1">
                        <p className="section-label px-2 py-1.5">Customers</p>
                        {searchResults.customers.map((customer) => (
                          <button
                            key={customer.id}
                            type="button"
                            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
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
                        <p className="section-label px-2 py-1.5">Job Tickets</p>
                        {searchResults.jobs.map((job) => (
                          <button
                            key={job.id}
                            type="button"
                            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
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
                        <p className="section-label px-2 py-1.5">Invoices</p>
                        {searchResults.invoices.map((invoice) => (
                          <button
                            key={invoice.id}
                            type="button"
                            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
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
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {/* The dashboard and job pages carry their own "New Job Ticket" button */}
          {hasPermission("Jobs: Create & Edit") && !["/", "/jobs", "/production"].includes(location.pathname) && (
            <Button size="sm" className="mr-1.5 hidden lg:inline-flex" onClick={() => navigate("/jobs?new=1")}>
              <Plus className="h-4 w-4" />
              New Job Ticket
            </Button>
          )}

          <ThemeToggle />

          <NotificationBell />

          {/* User Profile */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="ml-0.5 flex items-center gap-2 rounded-md p-0.5 text-left transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:py-1 xl:pl-1 xl:pr-2"
                aria-label="Account menu"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {initials}
                </span>
                <span className="hidden min-w-0 leading-tight xl:block">
                  <span className="block max-w-[140px] truncate text-[13px] font-medium">{user?.fullName || "My Account"}</span>
                  <span className={cn("block truncate text-[11px] text-muted-foreground", !user?.accessRoleName && "capitalize")}>{user?.role === "admin" ? "Admin" : user?.accessRoleName || user?.role || "user"}</span>
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="font-normal">
                <div className="truncate text-sm font-medium">{user?.fullName || "My Account"}</div>
                <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
                {user?.companyName && (
                  <div className="mt-1 truncate text-xs text-muted-foreground">{user.companyName}</div>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {hasPermission("Settings") && (
                <DropdownMenuItem onClick={() => navigate('/settings')}>
                  <Settings className="h-4 w-4" />
                  Settings
                </DropdownMenuItem>
              )}
              {hasPermission("User Management") && (
                <DropdownMenuItem onClick={() => navigate('/users')}>
                  <ShieldCheck className="h-4 w-4" />
                  User Management
                </DropdownMenuItem>
              )}
              {hasPermission("Activity Log") && (
                <DropdownMenuItem onClick={() => navigate('/activity-log')}>
                  <History className="h-4 w-4" />
                  Activity Log
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => signOut()}
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
