import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Home,
  Layers,
  LogOut,
  Menu,
  Moon,
  Search,
  ScrollText,
  Server,
  Settings,
  Sun,
  Terminal,
  UserRound,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { applyPalette, readStoredPalette } from "../lib/palette";
import { useMe } from "../lib/queries";
import { useToast } from "./Toast";
import { CommandPalette } from "./CommandPalette";
import { Logo } from "./Logo";
import { PageActionsHost } from "./PageActions";
import { Button, IconButton } from "./ui";
import { cn } from "../lib/format";

const navItems = [
  { label: "Overview", path: "/", icon: Home },
  { label: "Stacks", path: "/stacks", icon: Layers },
  { label: "Logs", path: "/logs", icon: ScrollText },
  { label: "Hosts", path: "/hosts", icon: Server },
  { label: "Activity", path: "/activity", icon: Activity },
  { label: "Settings", path: "/settings", icon: Settings },
];

const bottomNavItems = navItems.filter((item) => item.path !== "/settings");

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("cetus-theme");
    return stored === "light" ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem("cetus-theme", theme);
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((current) => current === "dark" ? "light" : "dark"),
    set: setTheme,
  };
}

function pageLabel(pathname: string) {
  if (pathname === "/") return "Overview";
  if (pathname.startsWith("/stacks/")) return "Stack detail";
  if (pathname === "/stacks") return "Stacks";
  if (pathname === "/logs") return "Logs";
  if (pathname.startsWith("/hosts")) return "Hosts";
  if (pathname === "/activity") return "Activity";
  if (pathname.startsWith("/settings")) return "Settings";
  return "Cetus";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { theme, toggle } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const mobileDialogRef = useRef<HTMLDialogElement>(null);

  const user = me.data?.user;
  const palette = me.data
    ? me.data.preferences.palette ?? me.data.defaultPalette
    : readStoredPalette();
  const initials = (user?.name ?? "C").split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();

  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.key === "Escape") setUserMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function logout() {
    try {
      await api.logout();
    } catch {
      // session may already be gone
    }
    queryClient.clear();
    window.location.href = "/";
  }

  const openMobileNav = () => {
    const dialog = mobileDialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  };

  const closeMobileNav = () => {
    mobileDialogRef.current?.close();
  };

  return (
    <div className="app-shell">
      <aside className="rail" aria-label="Primary navigation">
        <Link to="/" aria-label="Cetus home" style={{ display: "grid", placeItems: "center" }}>
          <Logo />
        </Link>
        <nav className="rail-nav">
          {navItems.map((item) => {
            const active = item.path === "/"
              ? pathname === "/"
              : item.path === "/stacks"
                ? pathname === "/stacks" || pathname.startsWith("/stacks/")
                : item.path.startsWith("/hosts")
                  ? pathname.startsWith("/hosts")
                  : pathname.startsWith(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className="rail-link"
                data-active={active}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
              >
                <item.icon size={19} strokeWidth={1.8} />
                <span className="rail-tooltip">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <IconButton label="Open navigation" className="mobile-nav" onClick={openMobileNav}>
            <Menu size={18} />
          </IconButton>
          <div className="topbar-title">
            <h1>{pageLabel(pathname)}</h1>
          </div>
          <PageActionsHost className="topbar-page-actions" />
          <div className="topbar-actions">
            <button className="search-trigger" onClick={() => setPaletteOpen(true)} aria-label="Search">
              <Search size={14} />
              <span>Search or jump</span>
              <kbd className="kbd">⌘K</kbd>
            </button>
            <IconButton label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggle}>
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </IconButton>
            <div style={{ position: "relative" }}>
              <button
                className="icon-btn"
                aria-label="Open user menu"
                aria-expanded={userMenuOpen}
                onClick={() => setUserMenuOpen((current) => !current)}
                style={{ width: 34, borderRadius: 999, background: "var(--accent-soft)", color: "var(--accent)", borderColor: "var(--accent-line)", fontWeight: 650, fontSize: 11 }}
              >
                {initials}
              </button>
              {userMenuOpen ? (
                <div
                  className="surface"
                  style={{ position: "absolute", right: 0, top: 42, width: 220, padding: 6, zIndex: 60, boxShadow: "var(--shadow)" }}
                  role="menu"
                >
                  <div style={{ padding: "8px 9px", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{user?.name ?? "Operator"}</div>
                    <div style={{ color: "var(--muted)", fontSize: 11.5 }}>{user?.email}</div>
                    <div className="badge badge-accent" style={{ marginTop: 6 }}>{user?.role ?? "viewer"}</div>
                  </div>
                  <Link
                    to="/settings"
                    className="command-item"
                    style={{ borderRadius: 7 }}
                    onClick={() => setUserMenuOpen(false)}
                    role="menuitem"
                  >
                    <Settings size={14} /> Settings
                  </Link>
                  <button className="command-item" style={{ borderRadius: 7, width: "100%" }} onClick={logout} role="menuitem">
                    <LogOut size={14} /> Sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <main className="content" data-wide={pathname === "/logs" ? "true" : undefined}>{children}</main>

        <nav className="bottom-nav" aria-label="Mobile navigation">
          {bottomNavItems.map((item) => {
            const active = item.path === "/"
              ? pathname === "/"
              : item.path === "/stacks"
                ? pathname === "/stacks" || pathname.startsWith("/stacks/")
                : item.path.startsWith("/hosts")
                  ? pathname.startsWith("/hosts")
                  : pathname.startsWith(item.path);
            return (
              <Link key={item.path} to={item.path} data-active={active} aria-current={active ? "page" : undefined}>
                <item.icon size={17} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <dialog ref={mobileDialogRef} className="dialog mobile-drawer" aria-label="Navigation" onCancel={(event) => { event.preventDefault(); closeMobileNav(); }}>
        <div className="dialog-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Logo size={30} />
            <strong>Cetus</strong>
          </div>
          <IconButton label="Close navigation" onClick={closeMobileNav}><X size={16} /></IconButton>
        </div>
        <div style={{ padding: 10 }}>
          {navItems.map((item) => (
            <Link key={item.path} to={item.path} className="command-item" onClick={closeMobileNav} style={{ borderRadius: 8 }}>
              <item.icon size={16} /> {item.label}
            </Link>
          ))}
          <button
            className="command-item"
            style={{ width: "100%", borderRadius: 8 }}
            onClick={() => {
              closeMobileNav();
              setPaletteOpen(true);
            }}
          >
            <Terminal size={16} /> Command palette
          </button>
          <button className="command-item" style={{ width: "100%", borderRadius: 8 }} onClick={logout}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </dialog>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onToggleTheme={toggle} />
    </div>
  );
}

export function SessionGate({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.isLoading) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <Logo size={48} />
          <div className="skeleton" style={{ width: 160, height: 8 }} />
        </div>
      </div>
    );
  }
  if (me.isError || !me.data?.user) {
    return <LoginRedirect />;
  }
  return <>{children}</>;
}

function LoginRedirect() {
  // The login route owns the form. This component only forces a hard navigation
  // when a session disappears while a protected page is mounted.
  useEffect(() => {
    if (window.location.pathname !== "/login") window.location.replace("/login");
  }, []);
  return null;
}
