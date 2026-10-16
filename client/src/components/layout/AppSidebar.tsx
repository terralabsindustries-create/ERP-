import { Link, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar";
import { BrandLogo, BrandMark } from "@/components/brand/BrandMark";
import { NAVIGATION } from "./navigation";
import { cn } from "@/lib/utils";

export function AppSidebar() {
  const location = useLocation();
  const { user, hasPermission } = useAuth();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-3 group-data-[collapsible=icon]:px-2">
        <Link
          to="/"
          className="flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          aria-label="Terralabs ERP home"
          onClick={() => isMobile && setOpenMobile(false)}
        >
          {collapsed ? <BrandMark className="h-7 w-7" /> : <BrandLogo tone="light" />}
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-0 py-2">
        {NAVIGATION.map((group) => {
          const seesWholeTeam = user?.role === "admin" || user?.canViewAllData === true;
          const items = group.items.filter(
            (item) => (!item.permission || (Array.isArray(item.permission) ? item.permission.some((p) => hasPermission(p)) : hasPermission(item.permission))) && (!item.orgViewOnly || seesWholeTeam)
          );
          if (items.length === 0) return null;

          return (
            <SidebarGroup key={group.label} className="px-2 py-1.5">
              <SidebarGroupLabel className="h-6 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-sidebar-muted">
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-px">
                  {items.map((item) => {
                    const isActive = location.pathname === item.href;
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          tooltip={item.title}
                          className={cn(
                            "relative h-9 gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-sidebar-foreground transition-colors md:h-8",
                            "hover:bg-white/[0.06] hover:text-white",
                            "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                            "data-[active=true]:bg-sidebar-primary/[0.14] data-[active=true]:font-semibold data-[active=true]:text-white",
                            "[&>svg]:text-sidebar-muted hover:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-primary"
                          )}
                        >
                          <Link
                            to={item.href}
                            aria-current={isActive ? "page" : undefined}
                            onClick={() => isMobile && setOpenMobile(false)}
                          >
                            {isActive && (
                              <span
                                className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-sidebar-primary group-data-[collapsible=icon]:inset-y-1"
                                aria-hidden
                              />
                            )}
                            <item.icon />
                            <span className="truncate">{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-3">
        {collapsed ? (
          <div className="cmyk-strip mx-auto h-1 w-6 rounded-full" />
        ) : (
          <div className="space-y-1.5">
            {user?.companyName && (
              <div className="truncate text-xs font-medium text-sidebar-foreground" title={user.companyName}>
                {user.companyName}
              </div>
            )}
            <div className="flex items-center justify-between text-[11px] text-sidebar-muted">
              <span>Terralabs ERP · v2.0</span>
              <span className="cmyk-strip h-1 w-8 rounded-full" aria-hidden />
            </div>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
