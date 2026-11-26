import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DockerImage, DockerNetwork, DockerVolume, MaintenanceInput } from "@shared/types";
import { api, ApiError } from "../lib/api";
import { queryKeys } from "../lib/queries";
import { useToast } from "./Toast";
import { Button, Dialog, Input } from "./ui";

export type MaintenanceTarget =
  | { kind: "image-remove"; image: DockerImage }
  | { kind: "image-prune" }
  | { kind: "volume-remove"; volume: DockerVolume }
  | { kind: "volume-prune" }
  | { kind: "network-remove"; network: DockerNetwork }
  | { kind: "network-prune" }
  | { kind: "container-prune" }
  | { kind: "system-prune" };

export function HostMaintenanceDialog({
  hostId,
  target,
  onClose,
}: {
  hostId: string;
  target: MaintenanceTarget | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [all, setAll] = useState(false);
  const [includeVolumes, setIncludeVolumes] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAll(false);
    setIncludeVolumes(false);
    setConfirm("");
    setError(null);
    setBusy(false);
  }, [target]);

  if (!target) return null;

  const spec = maintenanceSpec(target, all, includeVolumes);
  const requireText = target.kind === "volume-remove"
    ? target.volume.name
    : target.kind === "volume-prune" && all
      ? "prune"
      : target.kind === "system-prune" && includeVolumes
        ? "prune"
        : null;
  const confirmed = !requireText || confirm === requireText;
  const copy = describe(target);

  async function run() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.maintenance(hostId, spec);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory(hostId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.host(hostId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.hosts }),
        queryClient.invalidateQueries({ queryKey: queryKeys.audit() }),
      ]);
      toast.success(copy.toastTitle, toastMessage(result.output, copy.toastFallback));
      onClose();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : failure instanceof Error ? failure.message : "Docker maintenance failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={copy.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={copy.danger ? "danger" : "primary"} onClick={() => void run()} loading={busy} disabled={!confirmed}>
            {copy.confirm}
          </Button>
        </>
      }
    >
      <p style={{ marginTop: 0, color: "var(--text-soft)" }}>{copy.description}</p>

      {target.kind === "image-remove" ? (
        <TargetDetails
          title={`${target.image.repository}:${target.image.tag || "none"}`}
          meta={target.image.id}
          note={target.image.size}
        />
      ) : target.kind === "volume-remove" ? (
        <TargetDetails title={target.volume.name} meta={target.volume.mountpoint} note={target.volume.driver} />
      ) : target.kind === "network-remove" ? (
        <TargetDetails title={target.network.name} meta={target.network.id} note={target.network.driver} />
      ) : null}

      {target.kind === "image-prune" ? (
        <label className="auto-update-check">
          <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
          <span>Remove all unused images, not only dangling images</span>
        </label>
      ) : null}

      {target.kind === "volume-prune" ? (
        <label className="auto-update-check">
          <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
          <span>Include unused named volumes, not only anonymous volumes</span>
        </label>
      ) : null}

      {target.kind === "system-prune" ? (
        <div style={{ display: "grid", gap: 8 }}>
          <label className="auto-update-check">
            <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
            <span>Remove all unused images, not only dangling images</span>
          </label>
          <label className="auto-update-check">
            <input type="checkbox" checked={includeVolumes} onChange={(event) => setIncludeVolumes(event.target.checked)} />
            <span>Also remove unused anonymous volumes. This deletes their data.</span>
          </label>
        </div>
      ) : null}

      {target.kind === "volume-remove" || target.kind === "volume-prune" || (target.kind === "system-prune" && includeVolumes) ? (
        <div
          style={{
            marginTop: 12,
            padding: "9px 11px",
            border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)",
            borderRadius: 9,
            background: "var(--danger-soft)",
            color: "var(--danger)",
            fontSize: 12,
          }}
        >
          Volume data cannot be recovered after removal.
        </div>
      ) : null}

      {requireText ? (
        <div style={{ marginTop: 12 }}>
          <label className="label" htmlFor="maintenance-confirm">
            Type <span className="mono">{requireText}</span> to confirm
          </label>
          <Input
            id="maintenance-confirm"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="off"
            placeholder={requireText}
          />
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: "9px 11px",
            border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)",
            borderRadius: 9,
            background: "var(--danger-soft)",
            color: "var(--danger)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}

function TargetDetails({ title, meta, note }: { title: string; meta: string; note?: string }) {
  return (
    <div className="surface-soft" style={{ display: "grid", gap: 4, padding: "10px 12px", fontSize: 12 }}>
      <span className="mono" style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{title}</span>
      <span className="mono muted" style={{ fontSize: 11, overflowWrap: "anywhere" }}>{meta || "no path reported"}</span>
      {note ? <span className="muted" style={{ fontSize: 11 }}>{note}</span> : null}
    </div>
  );
}

function maintenanceSpec(target: MaintenanceTarget, all: boolean, volumes: boolean): MaintenanceInput {
  switch (target.kind) {
    case "image-remove":
      return {
        resource: "image",
        action: "remove",
        target: target.image.repository === "<none>"
          ? target.image.id
          : `${target.image.repository}:${target.image.tag || "none"}`,
      };
    case "image-prune":
      return { resource: "image", action: "prune", all };
    case "volume-remove":
      return { resource: "volume", action: "remove", target: target.volume.name };
    case "volume-prune":
      return { resource: "volume", action: "prune", all };
    case "network-remove":
      return { resource: "network", action: "remove", target: target.network.id };
    case "network-prune":
      return { resource: "network", action: "prune" };
    case "container-prune":
      return { resource: "container", action: "prune" };
    case "system-prune":
      return { resource: "system", action: "prune", all, volumes };
  }
}

function describe(target: MaintenanceTarget): {
  title: string;
  description: string;
  confirm: string;
  danger: boolean;
  toastTitle: string;
  toastFallback: string;
} {
  switch (target.kind) {
    case "image-remove":
      return {
        title: "Remove image",
        description: "Remove this image tag. Docker keeps the image if another tag references it, and refuses images used by a container.",
        confirm: "Remove image",
        danger: true,
        toastTitle: "Image removed",
        toastFallback: `${target.image.repository}:${target.image.tag || "none"} was removed.`,
      };
    case "image-prune":
      return {
        title: "Prune images",
        description: "Remove unused images from this host. Images used by a container are kept.",
        confirm: "Prune images",
        danger: true,
        toastTitle: "Images pruned",
        toastFallback: "Unused images were removed.",
      };
    case "volume-remove":
      return {
        title: "Remove volume",
        description: "Permanently delete this volume and its data. Volumes used by a container cannot be removed.",
        confirm: "Remove volume",
        danger: true,
        toastTitle: "Volume removed",
        toastFallback: `${target.volume.name} was removed.`,
      };
    case "volume-prune":
      return {
        title: "Prune volumes",
        description: "Remove unused volumes. Docker keeps volumes attached to a container.",
        confirm: "Prune volumes",
        danger: true,
        toastTitle: "Volumes pruned",
        toastFallback: "Unused volumes were removed.",
      };
    case "network-remove":
      return {
        title: "Remove network",
        description: "Remove this network. Networks with connected containers cannot be removed.",
        confirm: "Remove network",
        danger: true,
        toastTitle: "Network removed",
        toastFallback: `${target.network.name} was removed.`,
      };
    case "network-prune":
      return {
        title: "Prune networks",
        description: "Remove unused networks. Docker keeps bridge, host, none, and other active networks.",
        confirm: "Prune networks",
        danger: true,
        toastTitle: "Networks pruned",
        toastFallback: "Unused networks were removed.",
      };
    case "container-prune":
      return {
        title: "Prune containers",
        description: "Remove stopped containers. Running containers are kept.",
        confirm: "Prune containers",
        danger: true,
        toastTitle: "Containers pruned",
        toastFallback: "Stopped containers were removed.",
      };
    case "system-prune":
      return {
        title: "Prune unused Docker data",
        description: "Remove stopped containers, unused networks, dangling images, and build cache. Images used by a container are kept.",
        confirm: "Prune Docker data",
        danger: true,
        toastTitle: "Docker data pruned",
        toastFallback: "Unused Docker data was removed.",
      };
  }
}

function toastMessage(output: string, fallback: string): string {
  const reclaimed = output.split("\n").map((line) => line.trim()).find((line) => /total reclaimed space/i.test(line));
  if (reclaimed) return reclaimed;
  const first = output.split("\n").map((line) => line.trim()).find(Boolean);
  return first ?? fallback;
}
