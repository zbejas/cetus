import { useEffect, useMemo, useState } from "react";
import { Clock3, Globe2, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { AutoUpdateConfig } from "@shared/types";
import { useUpdateSettings } from "../lib/queries";
import { cronToTime, timeToCron } from "../lib/autoUpdate";
import { useToast } from "./Toast";
import { Button, Dialog, Input } from "./ui";

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

export function GlobalAutoUpdateDialog({
  open,
  config,
  onClose,
}: {
  open: boolean;
  config: AutoUpdateConfig;
  onClose: () => void;
}) {
  const toast = useToast();
  const update = useUpdateSettings();
  const [enabled, setEnabled] = useState(config.enabled);
  const [time, setTime] = useState(cronToTime(config.cron) ?? "04:00");
  const [timezone, setTimezone] = useState(config.timezone);
  const [customCron, setCustomCron] = useState(Boolean(config.cron && !cronToTime(config.cron)));
  const [cron, setCron] = useState(config.cron);
  const [healthCheck, setHealthCheck] = useState(config.healthCheck ?? true);
  const [rollback, setRollback] = useState(config.rollback ?? true);

  useEffect(() => {
    if (!open) return;
    setEnabled(config.enabled);
    setTime(cronToTime(config.cron) ?? "04:00");
    setTimezone(config.timezone);
    setCustomCron(Boolean(config.cron && !cronToTime(config.cron)));
    setCron(config.cron);
    setHealthCheck(config.healthCheck ?? true);
    setRollback(config.rollback ?? true);
  }, [open]);

  const effectiveCron = customCron ? cron.trim() : timeToCron(time);
  const cronError = useMemo(() => {
    if (!customCron) return null;
    return effectiveCron.split(/\s+/).length === 5 ? null : "Cron must have five fields.";
  }, [customCron, effectiveCron]);

  async function save() {
    if (cronError) return;
    try {
      await update.mutateAsync({
        autoUpdate: {
          enabled,
          cron: effectiveCron,
          timezone: timezone.trim() || "UTC",
          healthCheck,
          rollback,
          healthGraceSeconds: config.healthGraceSeconds ?? 90,
        },
      });
      toast.success("Global auto-update saved", enabled ? `Daily at ${time} in ${timezone}.` : "The global schedule is off.");
      onClose();
    } catch (error) {
      toast.error("Global auto-update not saved", error instanceof Error ? error.message : "The API rejected the change.");
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Global auto-update"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} loading={update.isPending} disabled={Boolean(cronError)}>
            Save schedule
          </Button>
        </>
      }
    >
      <div className="auto-update-dialog">
        <div className="auto-update-state">
          <span className="auto-update-state-icon"><Globe2 size={15} /></span>
          <div>
            <strong>{enabled ? "Fleet default is on" : "Fleet default is off"}</strong>
            <span>
              Stacks without their own schedule use this default. Per-stack schedules and service exclusions still win.
            </span>
          </div>
        </div>

        <div className="auto-update-row">
          <div>
            <div className="auto-update-label">Enable global schedule</div>
            <div className="help">Pull new image tags and recreate services on every stack that inherits this schedule.</div>
          </div>
          <Switch checked={enabled} onChange={setEnabled} label="Enable global auto-update" />
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
            {cronError ? <span className="help" style={{ color: "var(--danger)" }}>{cronError}</span> : <span className="help">Minute hour day month weekday. The timezone above is used.</span>}
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
          <Clock3 size={12} /> Open a stack's auto-update dialog to add a custom schedule or exclude services such as gluetun.
        </div>
      </div>
    </Dialog>
  );
}
