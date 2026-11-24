import { useEffect, useMemo, useState } from "react";
import { Clock3, Play, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Operation, StackDetail, StackMetadata } from "@shared/types";
import { api } from "../lib/api";
import { cronToTime, scheduleLabel, timeToCron } from "../lib/autoUpdate";
import { useToast } from "./Toast";
import { Button, Dialog, Input } from "./ui";
import { formatDate, relativeTime } from "../lib/format";

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
  const globalConfig = stack.globalAutoUpdate;
  const serviceNames = useMemo(() => stack.services.map((service) => service.name), [stack.services]);
  const [useGlobal, setUseGlobal] = useState(!existing);
  const [enabled, setEnabled] = useState(existing?.enabled ?? globalConfig?.enabled ?? false);
  const [time, setTime] = useState(cronToTime(existing?.cron ?? globalConfig?.cron) ?? "04:00");
  const [timezone, setTimezone] = useState(existing?.timezone ?? globalConfig?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [customCron, setCustomCron] = useState(Boolean((existing?.cron ?? globalConfig?.cron) && !cronToTime(existing?.cron ?? globalConfig?.cron)));
  const [cron, setCron] = useState(existing?.cron ?? globalConfig?.cron ?? "0 4 * * *");
  const [healthCheck, setHealthCheck] = useState(existing?.healthCheck ?? globalConfig?.healthCheck ?? true);
  const [rollback, setRollback] = useState(existing?.rollback ?? globalConfig?.rollback ?? true);
  const [excludedServices, setExcludedServices] = useState<string[]>(() => {
    if (!existing) return [];
    if (existing.excludeServices?.length) return existing.excludeServices;
    if (existing.services?.length) return serviceNames.filter((name) => !existing.services!.includes(name));
    return [];
  });
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open) return;
    const inherited = !existing;
    setUseGlobal(inherited);
    setEnabled(existing?.enabled ?? globalConfig?.enabled ?? false);
    setTime(cronToTime(existing?.cron ?? globalConfig?.cron) ?? "04:00");
    setTimezone(existing?.timezone ?? globalConfig?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    setCustomCron(Boolean((existing?.cron ?? globalConfig?.cron) && !cronToTime(existing?.cron ?? globalConfig?.cron)));
    setCron(existing?.cron ?? globalConfig?.cron ?? "0 4 * * *");
    setHealthCheck(existing?.healthCheck ?? globalConfig?.healthCheck ?? true);
    setRollback(existing?.rollback ?? globalConfig?.rollback ?? true);
    if (!existing) setExcludedServices([]);
    else if (existing.excludeServices?.length) setExcludedServices(existing.excludeServices);
    else if (existing.services?.length) setExcludedServices(serviceNames.filter((name) => !existing.services!.includes(name)));
    else setExcludedServices([]);
  }, [open]);

  const effectiveCron = customCron ? cron.trim() : timeToCron(time);
  const cronError = useMemo(() => {
    if (useGlobal || !customCron) return null;
    return effectiveCron.split(/\s+/).length === 5 ? null : "Cron must have five fields.";
  }, [customCron, effectiveCron, useGlobal]);
  const serviceError = !useGlobal && serviceNames.length > 0 && excludedServices.length >= serviceNames.length
    ? "Keep at least one service in the update set."
    : null;

  function toggleService(name: string) {
    setExcludedServices((current) =>
      current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name],
    );
  }

  async function save(runNow = false) {
    if (cronError || serviceError) return;
    setSaving(true);
    try {
      const metadata: StackMetadata = { ...stack.metadata };
      if (useGlobal) {
        delete metadata.autoUpdate;
      } else {
        metadata.autoUpdate = {
          enabled,
          cron: effectiveCron,
          timezone: timezone.trim() || "UTC",
          healthCheck,
          rollback,
          healthGraceSeconds: existing?.healthGraceSeconds ?? globalConfig?.healthGraceSeconds ?? 90,
          excludeServices: excludedServices.length > 0 ? excludedServices : undefined,
        };
      }
      await api.saveStackMetadata(stack.id, metadata);
      onSaved();
      if (useGlobal) {
        toast.success("Using global schedule", globalConfig?.enabled ? scheduleLabel(globalConfig) : "The global schedule is off.");
      } else {
        toast.success("Custom schedule saved", enabled ? `Daily at ${time} in ${timezone}.` : "Schedule is off.");
      }
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
          <Button variant="ghost" onClick={() => void save(true)} loading={running} disabled={saving || Boolean(cronError) || Boolean(serviceError)}>
            <Play size={13} /> Run now
          </Button>
          <Button variant="primary" onClick={() => void save(false)} loading={saving} disabled={Boolean(cronError) || Boolean(serviceError)}>
            Save schedule
          </Button>
        </>
      }
    >
      <div className="auto-update-dialog">
        <div className="auto-update-row">
          <div>
            <div className="auto-update-label">Use global schedule</div>
            <div className="help">
              {globalConfig?.enabled
                ? `${scheduleLabel(globalConfig)}. Stacks with a custom schedule ignore it.`
                : "The global schedule is off. Turn it on from Overview or Settings > Updates."}
            </div>
          </div>
          <Switch checked={useGlobal} onChange={setUseGlobal} label="Use global schedule" />
        </div>

        {useGlobal ? (
          <>
            <div className="auto-update-state">
              <span className="auto-update-state-icon"><Clock3 size={15} /></span>
              <div>
                <strong>{globalConfig?.enabled ? "Using the global schedule" : "Global schedule is off"}</strong>
                <span>{globalConfig ? scheduleLabel(globalConfig) : "No global schedule is configured."}</span>
              </div>
            </div>
            <div className="auto-update-hint">
              <Clock3 size={12} /> Turn the switch off to give this stack its own schedule and service exclusions.
            </div>
          </>
        ) : (
          <>
            <div className="auto-update-state">
              <span className="auto-update-state-icon"><RefreshCw size={15} /></span>
              <div>
                <strong>{enabled ? "Custom scheduled updates are on" : "Custom scheduled updates are off"}</strong>
                <span>
                  {enabled
                    ? `Next run ${nextRun ? formatDate(nextRun) : "not calculated yet"}`
                    : "Pull images and recreate services on this stack's own schedule."}
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
                <div className="auto-update-label">Enable custom schedule</div>
                <div className="help">Pull new image tags and recreate services on this stack only.</div>
              </div>
              <Switch checked={enabled} onChange={setEnabled} label="Enable custom auto-update" />
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
                {cronError ? <span className="help" style={{ color: "var(--danger)" }}>{cronError}</span> : <span className="help">Minute hour day month weekday. Server timezone handling follows the value above. For example, 0 */6 * * * runs every six hours.</span>}
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

            {serviceNames.length > 0 ? (
              <div>
                <div className="auto-update-label">Services to update</div>
                <div className="help">Uncheck a service to leave it on its current image. For example, exclude gluetun from updates.</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 8 }}>
                  {stack.services.map((service) => (
                    <label key={service.name} className="auto-update-check" style={{ margin: 0 }}>
                      <input
                        type="checkbox"
                        checked={!excludedServices.includes(service.name)}
                        onChange={() => toggleService(service.name)}
                      />
                      <span className="mono">{service.name}</span>
                    </label>
                  ))}
                </div>
                {serviceError ? <div className="help" style={{ color: "var(--danger)" }}>{serviceError}</div> : null}
              </div>
            ) : null}

            <div className="auto-update-hint">
              <ShieldCheck size={12} /> Scheduled runs skip services labeled io.zbejas.cetus.update=false or com.centurylinklabs.watchtower.enable=false. The stack Update button and Update all still update them.
            </div>
            <div className="auto-update-hint">
              <Clock3 size={12} /> Updates run inside Cetus. No Watchtower container is required.
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
