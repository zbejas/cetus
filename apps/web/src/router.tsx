import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { SessionGate, AppShell } from "./components/AppShell";
import { LoginPage } from "./pages/Login";
import { InvitePage } from "./pages/Invite";
import { DashboardPage } from "./pages/Dashboard";
import { StacksPage } from "./pages/Stacks";
import { StackDetailPage } from "./pages/StackDetail";
import { LogsPage } from "./pages/Logs";
import { HostsPage } from "./pages/Hosts";
import { HostDetailPage } from "./pages/HostDetail";
import { EnrollWorkerPage } from "./pages/EnrollWorker";
import { ActivityPage } from "./pages/Activity";
import { SettingsPage } from "./pages/Settings";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: function InviteRoute() {
    const { token } = inviteRoute.useParams();
    return <InvitePage token={token} />;
  },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: () => (
    <SessionGate>
      <AppShell>
        <Outlet />
      </AppShell>
    </SessionGate>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: DashboardPage,
});

const stacksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/stacks",
  component: StacksPage,
});

const stackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/stacks/$stackId",
  component: function StackRoute() {
    const { stackId } = stackRoute.useParams();
    return <StackDetailPage stackId={stackId} />;
  },
});

const logsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/logs",
  component: LogsPage,
});

const hostsIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/hosts",
  component: HostsPage,
});

const enrollWorkerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/hosts/enroll",
  component: EnrollWorkerPage,
});

const hostRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/hosts/$hostId",
  component: function HostRoute() {
    const { hostId } = hostRoute.useParams();
    return <HostDetailPage hostId={hostId} />;
  },
});

const activityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/activity",
  component: ActivityPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  appRoute.addChildren([
    indexRoute,
    stacksRoute,
    stackRoute,
    logsRoute,
    hostsIndexRoute,
    enrollWorkerRoute,
    hostRoute,
    activityRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
