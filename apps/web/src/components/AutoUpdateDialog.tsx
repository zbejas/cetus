import { useEffect, useMemo, useState } from "react";
import { Clock3, Play, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Operation, StackDetail, StackMetadata } from "@shared/types";
import { api } from "../lib/api";
import { useToast } from "./Toast";
import { Button, Dialog, Input } from "./ui";
import { formatDate, relativeTime } from "../lib/format";

function cronToTime(cron: string | undefined) {
  if (!cron) return null;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  if (!fields[2].includes("*") || !fields[3].includes("*") || !fields[4].includes("*")) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeToCron(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return `${Number.isFinite(minute) ? minute : 0} ${Number.isFinite(hour) ? hour : 4} * * *`;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="settings-switch"
      data-on={checked}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function AutoUpdateDialog({
  stack,
  open,
  onClose,
  onStarted,
  onSaved,
}: {
  stack: StackDetail;
  open: boolean;
  onClose: () => void;
  onStarted: (operation: Operation) => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const existing = stack.metadata.autoUpdate;
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [time, setTime] = useState(cronToTime(existing?.cron) ?? "04:00");
  const [timezone, setTimezone] = useState(existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [customCron, setCustomCron] = useState(Boolean(existing?.cron && !cronToTime(existing.cron)));
  const [cron, setCron] = useState(existing?.cron ?? "0 4 * * *");
  const [healthCheck, setHealthCheck] = useState(existing?.healthCheck ?? true);
  const [rollback, setRollback] = useState(existing?.rollback ?? true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEnabled(existing?.enabled ?? false);
    setTime(cronToTime(existing?.cron) ?? "04:00");
    setTimezone(existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    setCustomCron(Boolean(existing?.cron && !cronToTime(existing.cron)));
    setCron(existing?.cron ?? "0 4 * * *");
    setHealthCheck(existing?.healthCheck ?? true);
    setRollback(existing?.rollback ?? true);
  }, [open, existing?.cron, existing?.enabled, existing?.healthCheck, existing?.rollback, existing?.timezone]);

  const effectiveCron = customCron ? cron.trim() : timeToCron(time);
  const cronError = useMemo(() => {
    if (!customCron) return null;
    return effectiveCron.split(/\s+/).length === 5 ? null : "Cron must have five fields.";
  }, [customCron, effectiveCron]);

  async function save(runNow = false) {
    if (cronError) return;
    setSaving(true);
    try {
      const metadata: StackMetadata = {
        ...stack.metadata,
        autoUpdate: {
          enabled,
          cron: effectiveCron,
          timezone: timezone.trim() || "UTC",
          healthCheck,
          rollback,
          healthGraceSeconds: existing?.healthGraceSeconds ?? 90,
          services: existing?.services,
        },
      };
      await api.saveStackMetadata(stack.id, metadata);
      onSaved();
      toast.success("Auto-update saved", enabled ? `Daily at ${time} in ${timezone}.` : "Schedule is off.");
      if (runNow) {
        setRunning(true);
        const operation = await api.runAutoUpdate(stack.id);
        onStarted(operation);
        toast.success("Auto-update started", "The operation output is on the stack page.");
      }
      onClose();
    } catch (error) {
      toast.error(runNow ? "Update not started" : "Auto-update not saved", error instanceof Error ? error.message : "The API rejected the change.");
    } finally {
      setSaving(false);
      setRunning(false);
    }
  }

  const nextRun = stack.autoUpdateState?.nextRunAt;
  const lastRun = stack.autoUpdateState?.lastRunAt;
  const lastStatus = stack.autoUpdateState?.lastStatus;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Auto-update · ${stack.displayName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="ghost" onClick={() => void save(true)} loading={running} disabled={saving || Boolean(cronError)}>
            <Play size={13} /> Run now
          </Button>
          <Button variant="primary" onClick={() => void save(false)} loading={saving} disabled={Boolean(cronError)}>
            Save schedule
          </Button>
        </>
      }
    >
      <div className="auto-update-dialog">
        <div className="auto-update-state">
          <span className="auto-update-state-icon"><RefreshCw size={15} /></span>
          <div>
            <strong>{enabled ? "Scheduled updates are on" : "Scheduled updates are off"}</strong>
            <span>
              {enabled
                ? `Next run ${nextRun ? formatDate(nextRun) : "not calculated yet"}`
                : "Turn this on to pull images and recreate services on a schedule."}
            </span>
          </div>
          {lastRun ? (
            <span className="auto-update-last" data-status={lastStatus ?? undefined}>
              Last {lastStatus ?? "run"} {relativeTime(lastRun)}
            </span>
          ) : null}
        </div>

        <div className="auto-update-row">
          <div>
            <div className="auto-update-label">Enable schedule</div>
            <div className="help">Pull new image tags and recreate services.</div>
          </div>
          <Switch checked={enabled} onChange={setEnabled} label="Enable auto-update" />
        </div>

        <div className="auto-update-grid">
          <label className="field">
            <span className="label">Daily time</span>
            <Input type="time" value={time} disabled={customCron} onChange={(event) => setTime(event.target.value)} />
          </label>
          <label className="field">
            <span className="label">Timezone</span>
            <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Europe/Ljubljana" />
          </label>
        </div>

        <label className="auto-update-check">
          <input type="checkbox" checked={customCron} onChange={(event) => setCustomCron(event.target.checked)} />
          <span>Use a custom cron expression</span>
        </label>
        {customCron ? (
          <label className="field">
            <span className="label">Cron</span>
            <Input className="mono" value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 4 * * *" />
            {cronError ? <span className="help" style={{ color: "var(--danger)" }}>{cronError}</span> : <span className="help">Minute hour day month weekday. Server timezone handling follows the value above.</span>}
          </label>
        ) : null}

        <div className="auto-update-row">
          <div>
            <div className="auto-update-label"><ShieldCheck size={13} /> Health gate</div>
            <div className="help">Wait for containers to stay running and healthy before reporting success.</div>
          </div>
          <Switch checked={healthCheck} onChange={setHealthCheck} label="Health gate" />
        </div>
        <div className="auto-update-row">
          <div>
            <div className="auto-update-label"><TriangleAlert size={13} /> Roll back on failure</div>
            <div className="help">Restore the previous compose file and image IDs if the health gate fails.</div>
          </div>
          <Switch checked={rollback} onChange={setRollback} label="Rollback on failure" />
        </div>

        <div className="auto-update-hint">
          <Clock3 size={12} /> Updates run inside Cetus. No Watchtower container is required.
        </div>
      </div>
    </Dialog>
  );
}
