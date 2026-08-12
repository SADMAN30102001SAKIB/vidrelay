"use client";

import {
  Cable,
  LayoutDashboard,
  LogOut,
  PlusCircle,
  ScrollText,
  Settings
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { clsx } from "clsx";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useSession } from "@/providers/SessionProvider";

import { Brand } from "./Brand";
import { Button, ErrorState, LoadingState } from "./ui";

interface NavigationItem {
  exact?: boolean;
  href: string;
  icon: LucideIcon;
  label: string;
}

const navigation: NavigationItem[] = [
  { exact: true, href: "/app", icon: LayoutDashboard, label: "Overview" },
  { href: "/app/create", icon: PlusCircle, label: "Create" },
  { href: "/app/posts", icon: ScrollText, label: "Posts" },
  { href: "/app/connections", icon: Cable, label: "Connections" },
  { href: "/app/settings", icon: Settings, label: "Settings" }
];

const isActive = (pathname: string, item: NavigationItem): boolean =>
  item.exact === true ? pathname === item.href : pathname.startsWith(item.href);

function Navigation({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={mobile ? "Mobile" : "App"}
      className={mobile ? "mobile-nav" : "side-nav"}>
      {navigation.map(item => {
        const Icon = item.icon;
        const active = isActive(pathname, item);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={clsx(
              mobile ? "mobile-nav-link" : "side-nav-link",
              active &&
                (mobile ? "mobile-nav-link-active" : "side-nav-link-active")
            )}
            href={item.href}
            key={item.href}>
            <Icon aria-hidden="true" size={19} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { logout, refresh, status, user } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const requestLogout = () => {
    void logout().catch(() => undefined);
  };

  useEffect(() => {
    if (status === "anonymous") {
      const returnTo = `${pathname}${window.location.search}`;
      router.replace(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }, [pathname, router, status]);

  if (status === "loading" || status === "anonymous") {
    return <LoadingState label="Checking your session…" />;
  }
  if (status === "error" || user === null) {
    return (
      <ErrorState
        action={<Button onClick={() => void refresh()}>Try again</Button>}
        description="We could not confirm your account session."
      />
    );
  }

  return (
    <div className="app-frame">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <Brand href="/app" />
        </div>
        <Navigation />
        <div className="sidebar-account">
          <span className="account-name">{user.name}</span>
          <span className="account-email">{user.email}</span>
          <Button onClick={requestLogout} size="small" variant="ghost">
            <LogOut aria-hidden="true" size={16} />
            Log out
          </Button>
        </div>
      </aside>
      <div className="app-column">
        <header className="app-header">
          <Brand href="/app" />
          <span className="workspace-name">{user.workspace.name}</span>
          <Button
            className="mobile-logout"
            onClick={requestLogout}
            size="small"
            variant="ghost">
            <LogOut aria-hidden="true" size={16} />
            Log out
          </Button>
        </header>
        <main className="app-main" id="main-content">
          {children}
        </main>
        <Navigation mobile />
      </div>
    </div>
  );
}
