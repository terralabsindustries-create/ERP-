import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { Header } from "./Header";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only z-[60] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <div className="flex h-dvh w-full bg-background print:block print:h-auto">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-auto focus:outline-none print:overflow-visible">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
