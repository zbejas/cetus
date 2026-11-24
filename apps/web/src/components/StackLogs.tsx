import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { LogViewer, type LogViewerSource } from "./LogViewer";
import type { ServiceState } from "@shared/types";

export function StackLogs({
  stackId,
  hostId,
  stackName,
  services = [],
  compact = false,
  remote = false,
  selectedService = null,
  onSelectService,
}: {
  stackId: string;
  hostId: string;
  stackName: string;
  services?: ServiceState[];
  compact?: boolean;
  remote?: boolean;
  selectedService?: string | null;
  onSelectService?: (serviceName: string | null) => void;
}) {
  const withContainers = useMemo(() => services.filter((service) => service.containerId), [services]);
  const selected = selectedService && withContainers.some((entry) => entry.name === selectedService)
    ? selectedService
    : "all";
  const service = withContainers.find((entry) => entry.name === selected) ?? null;

  const source: LogViewerSource = service?.containerId
    ? {
        kind: "container",
        id: service.containerId,
        hostId,
        title: `${stackName} / ${service.name}`,
        subtitle: `${service.image} · ${service.state}`,
        remote,
        live: service.state === "running",
      }
    : {
        kind: "stack",
        id: stackId,
        hostId,
        title: "All services",
        subtitle: `${stackName} · compose stream`,
        remote,
        live: services.some((entry) => entry.state === "running"),
      };

  const fullView = service?.containerId
    ? { to: "/logs" as const, search: { container: service.containerId, host: hostId } }
    : { to: "/logs" as const, search: {} };

  return (
    <LogViewer
      source={source}
      compact={compact}
      extraHeader={
        <div className="stack-log-selector">
          <select
            value={selected}
            onChange={(event) => onSelectService?.(event.target.value === "all" ? null : event.target.value)}
            aria-label="Select a service to tail"
          >
            <option value="all">All services</option>
            {withContainers.map((entry) => (
              <option key={entry.name} value={entry.name}>{entry.name}</option>
            ))}
          </select>
          <Link {...fullView} className="log-open-full" title="Open in the fleet log viewer">
            <ExternalLink size={12} /> Full logs
          </Link>
        </div>
      }
    />
  );
}
