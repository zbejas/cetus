import type { MaintenanceAction, MaintenanceInput, MaintenanceResource } from "@shared/types.ts";

const RESOURCES = new Set<MaintenanceResource>(["image", "volume", "network", "container", "builder", "system"]);
const ACTIONS = new Set<MaintenanceAction>(["remove", "prune"]);
const REMOVABLE = new Set<MaintenanceResource>(["image", "volume", "network"]);

export function parseMaintenanceInput(input: MaintenanceInput): MaintenanceInput {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid maintenance request.");
  }
  if (!RESOURCES.has(input.resource)) {
    throw new Error("Unsupported maintenance resource.");
  }
  if (!ACTIONS.has(input.action)) {
    throw new Error("Unsupported maintenance action.");
  }
  if (input.action === "remove" && !REMOVABLE.has(input.resource)) {
    throw new Error("This resource can only be pruned.");
  }

  const spec: MaintenanceInput = {
    resource: input.resource,
    action: input.action,
  };
  if (input.target !== undefined) {
    const target = String(input.target).trim();
    if (!target) throw new Error("A maintenance target is required.");
    if (target.startsWith("-")) throw new Error("Invalid maintenance target.");
    const pattern = input.resource === "image"
      ? /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/
      : /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
    if (!pattern.test(target)) throw new Error("Invalid maintenance target.");
    spec.target = target;
  }
  if (input.action === "remove" && !spec.target) {
    throw new Error("A maintenance target is required.");
  }
  if (input.all !== undefined) spec.all = Boolean(input.all);
  if (input.volumes !== undefined) spec.volumes = Boolean(input.volumes);
  return spec;
}

export function maintenanceArgs(spec: MaintenanceInput): string[] {
  switch (spec.resource) {
    case "image":
      return spec.action === "remove"
        ? ["image", "rm", spec.target!]
        : ["image", "prune", "-f", ...(spec.all ? ["-a"] : [])];
    case "volume":
      return spec.action === "remove"
        ? ["volume", "rm", spec.target!]
        : ["volume", "prune", "-f", ...(spec.all ? ["-a"] : [])];
    case "network":
      return spec.action === "remove"
        ? ["network", "rm", spec.target!]
        : ["network", "prune", "-f"];
    case "container":
      return ["container", "prune", "-f"];
    case "builder":
      return ["builder", "prune", "-f"];
    case "system":
      return [
        "system",
        "prune",
        "-f",
        ...(spec.all ? ["-a"] : []),
        ...(spec.volumes ? ["--volumes"] : []),
      ];
  }
}

export function maintenanceScope(spec: MaintenanceInput): string {
  switch (spec.resource) {
    case "image":
      return spec.action === "prune" ? "images:prune" : "images:write";
    case "volume":
      return spec.action === "prune" ? "volumes:prune" : "volumes:write";
    case "network":
      return spec.action === "prune" ? "networks:prune" : "networks:write";
    case "container":
    case "builder":
    case "system":
      return "system:prune";
  }
}

export function maintenanceAction(spec: MaintenanceInput): string {
  return `${spec.resource}.${spec.action}`;
}
