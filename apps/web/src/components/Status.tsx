import { Badge } from "./ui";
import type { StackStatus } from "@shared/types";
import { titleCase } from "../lib/format";

const tone: Record<string, "default" | "accent" | "success" | "warn" | "danger" | "info"> = {
  running: "success",
  healthy: "success",
  online: "success",
  success: "success",
  partial: "warn",
  updating: "warn",
  starting: "warn",
  created: "info",
  stopped: "default",
  unknown: "default",
  offline: "danger",
  error: "danger",
  failed: "danger",
  unhealthy: "danger",
  exited: "danger",
};

const label: Record<string, string> = {
  running: "Running",
  partial: "Degraded",
  stopped: "Stopped",
  created: "Not deployed",
  error: "Error",
  unknown: "Unknown",
  updating: "Updating",
};

export function StatusBadge({ status, compact = false }: { status: StackStatus | string; compact?: boolean }) {
  return (
    <Badge tone={tone[status] ?? "default"}>
      <span className="status-dot" data-status={status} />
      {compact ? null : label[status] ?? titleCase(status)}
    </Badge>
  );
}

export function StatusDot({ status }: { status: string }) {
  return <span className="status-dot" data-status={status} title={titleCase(status)} />;
}
