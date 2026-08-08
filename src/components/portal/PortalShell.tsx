"use client";

import { ReactNode, useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useClerk, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import {
  LayoutDashboard,
  Calendar,
  CreditCard,
  MessageSquare,
  LogOut,
  Menu,
  ChevronRight,
  Heart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { DobVerification } from "@/components/portal/identity/DobVerification";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/appointments", label: "Appointments", icon: Calendar },
  { href: "/membership", label: "Membership", icon: CreditCard },
  { href: "/messages", label: "Messages", icon: MessageSquare },
];

const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/schedule",
  "/employee-login",
  "/sso-callback",
];

/** Strip the `/portal` rewrite prefix so SSR and client pathnames agree. */
function normalizePortalPath(pathname: string): string {
  return pathname.replace(/^\/portal/, "") || "/";
}

function isPublicPath(pathname: string): boolean {
  const clean = normalizePortalPath(pathname);
  return PUBLIC_PATHS.some(
    (p) => clean === p || clean.startsWith(p + "/")
  );
}

type IdentityGateState =
  | "loading"
  | "disambiguation"
  | "registration_incomplete"
  | "verified";

function SidebarContent({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  const { signOut } = useClerk();

  return (
    <>
      <div className="flex items-center gap-2 px-6 py-4">
        <Heart className="h-6 w-6 text-primary" fill="currentColor" />
        <span className="font-serif text-lg font-medium">Her</span>
        <div className="ml-auto">
          <UserButton
            appearance={{
              elements: { avatarBox: "h-8 w-8" },
            }}
          />
        </div>
      </div>
      <Separator />
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const clean = normalizePortalPath(pathname);
          const isActive =
            clean === item.href || clean.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {item.label}
              {isActive && <ChevronRight className="h-4 w-4 ml-auto" />}
            </Link>
          );
        })}
      </nav>
      <Separator />
      <div className="px-3 py-4">
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-muted-foreground"
          onClick={() => signOut({ redirectUrl: "/login" })}
        >
          <LogOut className="h-5 w-5 shrink-0" />
          Sign Out
        </Button>
      </div>
    </>
  );
}

export function PortalShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
  const isPublic = isPublicPath(pathname);
  const [identityStatus, setIdentityStatus] = useState<{
    state: IdentityGateState;
    checkedPath: string | null;
  }>({ state: "loading", checkedPath: null });

  useEffect(() => {
    if (isPublic) return;

    let cancelled = false;

    fetch("/api/portal/auth/session")
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setIdentityStatus({ state: "verified", checkedPath: pathname });
          return;
        }
        const data = await res.json();
        if (cancelled) return;

        let state: IdentityGateState = "verified";
        if (data.user?.disambiguationRequired) {
          state = "disambiguation";
        } else if (
          data.user?.registrationComplete === false &&
          !data.user?.athenaPatientId
        ) {
          state = "registration_incomplete";
        }

        setIdentityStatus({ state, checkedPath: pathname });
      })
      .catch(() => {
        if (!cancelled)
          setIdentityStatus({ state: "verified", checkedPath: pathname });
      });

    return () => {
      cancelled = true;
    };
  }, [isPublic, pathname]);

  const effectiveGateState: IdentityGateState =
    isPublic ? "verified" :
      identityStatus.checkedPath !== pathname ? "loading" :
        identityStatus.state;

  if (isPublic) {
    return (
      <div
        className="min-h-screen bg-secondary"
        data-restrict-tracking="true"
      >
        {children}
      </div>
    );
  }

  if (effectiveGateState === "loading") {
    return (
      <div
        className="min-h-screen bg-muted/40 flex items-center justify-center"
        data-restrict-tracking="true"
      >
        <div className="animate-pulse text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (effectiveGateState === "disambiguation") {
    return (
      <div data-restrict-tracking="true">
        <DobVerification
          onVerified={() => window.location.reload()}
        />
      </div>
    );
  }

  if (effectiveGateState === "registration_incomplete") {
    router.replace("/register");
    return (
      <div
        className="min-h-screen bg-muted/40 flex items-center justify-center"
        data-restrict-tracking="true"
      >
        <div className="animate-pulse text-muted-foreground">
          Redirecting to registration...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/40 flex" data-restrict-tracking="true">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:border-r bg-card">
        <SidebarContent pathname={pathname} />
      </aside>

      {/* Mobile sidebar via Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top bar */}
          <header className="h-16 bg-card border-b flex items-center px-4 lg:px-8 sticky top-0 z-30">
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden -ml-2"
              >
                <Menu className="h-5 w-5" />
                <span className="sr-only">Open menu</span>
              </Button>
            </SheetTrigger>
            <div className="ml-4 lg:ml-0">
              <BreadcrumbFromPath pathname={pathname} />
            </div>
          </header>

          {/* Page content */}
          <main className="flex-1 p-4 lg:p-8">{children}</main>
        </div>

        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <SidebarContent
            pathname={pathname}
            onNavigate={() => setSheetOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function BreadcrumbFromPath({ pathname }: { pathname: string }) {
  const segments = normalizePortalPath(pathname).split("/").filter(Boolean);

  if (segments.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Link href="/dashboard" className="hover:text-foreground transition-colors">
        Her
      </Link>
      {segments.map((segment, i) => (
        <span key={i} className="flex items-center gap-1.5">
          <ChevronRight className="h-3.5 w-3.5" />
          <span
            className={cn(
              i === segments.length - 1 && "text-foreground font-medium"
            )}
          >
            {segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, " ")}
          </span>
        </span>
      ))}
    </div>
  );
}
