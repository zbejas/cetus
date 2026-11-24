import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import YAML from "yaml";
import {
  ArrowLeft,
  Box,
  Braces,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Copy,
  Cpu,
  ExternalLink,
  Eye,
  FileCode2,
  History,
  LockKeyhole,
  Layers,
  ListFilter,
  MemoryStick,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Rocket,
  RotateCw,
  Save,
  ScrollText,
  Server,
  Settings2,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, ApiError, can, scopeReason } from "../lib/api";
import { useCheckUpdates, useMe, useOperation, useOperations, useRestoreSnapshot, useSaveStack, useStack, useStackAction } from "../lib/queries";
import { useToast } from "../components/Toast";
import { Badge, Button, Dialog, EmptyState, IconButton, Input, PageHeader, Skeleton } from "../components/ui";
import { StatusBadge, StatusDot } from "../components/Status";
import { YamlEditor } from "../components/YamlEditor";
import { StackLogs } from "../components/StackLogs";
import { AutoUpdateDialog } from "../components/AutoUpdateDialog";
import { formatBytes, formatDate, formatPercent, relativeTime, shortId, titleCase } from "../lib/format";
import type { ServiceState } from "@shared/types";

type DockTab = "logs" | "events" | "stats" | "console";
type EditorTab = "compose" | "env" | "metadata";

export function StackDetailPage({ stackId }: { stackId: string }) {
  const stackQuery = useStack(stackId);
  const stack = stackQuery.data;
  const me = useMe();
  const scopes = me.data?.actor.scopes;
  const canWrite = can(scopes, "stacks:write");
  const canDeploy = can(scopes, "stacks:deploy");
  const canExec = can(scopes, "containers:exec");
  const canDelete = can(scopes, "stacks:delete");
  const canAudit = can(scopes, "audit:read");
  const updateErrors = stack?.updateCheck?.services.filter((service) => service.error).length ?? 0;
  const remoteStack = Boolean(stack && (stack.hostKind !== "local" || stack.hostId !== "host-local"));
  const envRedacted = Boolean(stack?.envRedacted);
  const action = useStackAction(stackId);
  const save = useSaveStack(stackId);
  const updateCheck = useCheckUpdates(stackId);
  const restore = useRestoreSnapshot(stackId);
  const audit = useQuery({
    queryKey: ["audit", stackId],
    queryFn: () => api.audit({ stackId, limit: 100 }),
    enabled: canAudit,
    refetchInterval: 8_000,
  });
  const operations = useOperations();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [logsService, setLogsService] = useState<string | null>(null);
  const [dockTab, setDockTab] = useState<DockTab>("logs");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTab, setEditorTab] = useState<EditorTab>("compose");
  const [editorReadOnly, setEditorReadOnly] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [envText, setEnvText] = useState("");
  const [metadataText, setMetadataText] = useState("{}");
  const [baseHash, setBaseHash] = useState("");
  const [dirty, setDirty] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [autoUpdateOpen, setAutoUpdateOpen] = useState(false);
  const dockRef = useRef<HTMLElement | null>(null);

  function openServiceLogs(serviceName: string) {
    setSelectedService(serviceName);
    setLogsService(serviceName);
    setDockTab("logs");
    window.requestAnimationFrame(() => {
      dockRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function runUpdateCheck() {
    if (updateCheck.isPending) return;
    try {
      const result = await updateCheck.mutateAsync();
      const available = result.services.filter((service) => service.updateAvailable);
      if (available.length > 0) {
        toast.success(
          "Updates available",
          available.map((service) => service.service).join(", "),
        );
      } else {
        const errors = result.services.filter((service) => service.error);
        if (errors.length > 0) {
          toast.push({
            title: "Check incomplete",
            description: `${errors.length} service${errors.length === 1 ? "" : "s"} could not be checked. ${errors[0].error ?? ""}`.trim(),
            tone: "info",
          });
        } else {
          toast.success("Images are current", "Every image matches its registry digest.");
        }
      }
    } catch (error) {
      toast.error("Update check failed", error instanceof Error ? error.message : "The registry check did not complete.");
    }
  }
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [consoleService, setConsoleService] = useState("");
  const [consoleCommand, setConsoleCommand] = useState("ls -la");
  const [consoleOutput, setConsoleOutput] = useState("");
  const [consoleRunning, setConsoleRunning] = useState(false);
  const lastOperationStatus = useRef<string | null>(null);

  const operation = useOperation(operationId);

  useEffect(() => {
    if (!stack) return;
    if (!selectedService && stack.services[0]) setSelectedService(stack.services[0].name);
    if (!consoleService && stack.services[0]) setConsoleService(stack.services[0].name);
  }, [stack, selectedService, consoleService]);

  useEffect(() => {
    if (!stack || editorOpen) return;
    if (dirty) return;
    setComposeText(stack.compose);
    setEnvText(stack.env);
    setMetadataText(JSON.stringify(stack.metadata ?? {}, null, 2));
    setBaseHash(stack.composeHash);
  }, [stack?.id, stack?.composeHash, stack?.envHash, editorOpen, dirty]);

  useEffect(() => {
    if (!operation.data) return;
    const status = operation.data.status;
    if (status === lastOperationStatus.current) return;
    lastOperationStatus.current = status;
    if (status === "success") {
      toast.success("Operation complete", `${titleCase(operation.data.type)} finished successfully.`);
      queryClient.invalidateQueries({ queryKey: ["stack", stackId] });
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
    }
    if (status === "failed") {
      toast.error("Operation failed", `Exit code ${operation.data.exitCode ?? "unknown"}. Open the operation output for the last lines.`);
      queryClient.invalidateQueries({ queryKey: ["stack", stackId] });
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
    }
  }, [operation.data, queryClient, stackId, toast]);

  const selected = useMemo(
    () => stack?.services.find((service) => service.name === selectedService) ?? stack?.services[0] ?? null,
    [selectedService, stack?.services],
  );

  const localYamlError = useMemo(() => {
    if (!composeText) return null;
    try {
      const parsed = YAML.parse(composeText);
      if (!parsed?.services || Object.keys(parsed.services).length === 0) return "At least one service is required.";
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid YAML";
    }
  }, [composeText]);

  function openEditor(tab: EditorTab = "compose", readOnly = false) {
    if (!stack) return;
    if (stack.hostKind === "worker" && !readOnly) {
      toast.push({
        title: "Remote editing is not enabled yet",
        description: "Actions, logs, and inventory work over the worker channel. Compose editing is the next slice.",
        tone: "info",
      });
      return;
    }
    if (!canWrite && !readOnly) return;
    setComposeText(stack.compose);
    setEnvText(envRedacted ? "" : stack.env);
    setMetadataText(JSON.stringify(stack.metadata ?? {}, null, 2));
    setBaseHash(stack.composeHash);
    setEditorReadOnly(readOnly || !canWrite);
    setEditorTab(tab);
    setEditorOpen(true);
    setDirty(false);
  }

  function updateCompose(next: string) {
    setComposeText(next);
    setDirty(true);
  }

  async function saveFiles(): Promise<boolean> {
    if (!canWrite) {
      toast.error("Read-only session", scopeReason("stacks:write"));
      return false;
    }
    if (localYamlError) {
      toast.error("Compose is invalid", localYamlError);
      return false;
    }
    let metadata = undefined;
    try {
      metadata = JSON.parse(metadataText || "{}");
    } catch {
      toast.error("Metadata is not valid JSON", "Fix cetus.json before saving.");
      return false;
    }
    try {
      const result = await save.mutateAsync({
        compose: composeText,
        ...(envRedacted ? {} : { env: envText }),
        metadata,
        baseHash,
      });
      setBaseHash(result.composeHash);
      setDirty(false);
      toast.success("Saved", "Compose files and snapshots are up to date.");
      return true;
    } catch (error) {
      toast.error("Save failed", error instanceof ApiError ? error.message : "Unknown error");
      return false;
    }
  }

  async function deploy() {
    if (!canDeploy) return;
    if (editorOpen && dirty) {
      const saved = await saveFiles();
      if (!saved) return;
    }
    action.mutate({ action: "deploy" }, {
      onSuccess: (result) => {
        setOperationId(result.id);
        setEditorOpen(false);
        setDockTab("logs");
        toast.push({ title: "Deploy started", description: "Streaming phases and service state.", tone: "info" });
      },
      onError: (error) => toast.error("Deploy failed to start", error instanceof ApiError ? error.message : "Unknown error"),
    });
  }

  function runAction(name: string) {
    if (!canDeploy) return;
    setMoreOpen(false);
    action.mutate({ action: name }, {
      onSuccess: (result) => {
        setOperationId(result.id);
        toast.push({ title: `${titleCase(name)} started`, tone: "info" });
      },
      onError: (error) => toast.error(`${titleCase(name)} failed`, error instanceof ApiError ? error.message : "Unknown error"),
    });
  }

  function runServiceAction(service: string, name: string) {
    if (!canDeploy) return;
    api.serviceAction(stackId, service, name).then((result) => {
      setOperationId(result.id);
      setSelectedService(service);
      toast.push({ title: `${titleCase(name)} ${service}`, tone: "info" });
    }).catch((error) => toast.error("Service action failed", error instanceof Error ? error.message : "Unknown error"));
  }

  async function runConsole() {
    if (!canExec || remoteStack || !consoleService || !consoleCommand.trim()) return;
    setConsoleRunning(true);
    setConsoleOutput(`$ docker compose exec -T ${consoleService} sh -lc ${JSON.stringify(consoleCommand)}\n\n`);
    try {
      const result = await api.exec(stackId, consoleService, consoleCommand);
      setConsoleOutput((current) => current + (result.stdout || "") + (result.stderr ? `\n[stderr]\n${result.stderr}` : "") + `\n[exit ${result.exitCode}]`);
    } catch (error) {
      setConsoleOutput((current) => current + (error instanceof ApiError ? error.message : "Command failed."));
    } finally {
      setConsoleRunning(false);
    }
  }

  async function confirmDelete() {
    if (!stack || !canDelete || remoteStack || confirmName !== stack.name) return;
    try {
      const result = await api.stackAction(stackId, "delete", { confirmName });
      setOperationId(result.id);
      setDeleteOpen(false);
      toast.success("Stack removed", "The directory moved to Cetus trash.");
      navigate({ to: "/stacks" });
    } catch (error) {
      toast.error("Delete failed", error instanceof ApiError ? error.message : "Unknown error");
    }
  }

  function copy(value: string, label = "Copied") {
    navigator.clipboard.writeText(value).then(() => toast.success(label, value));
  }

  const stackOperations = (operations.data ?? []).filter((operation) => operation.stackId === stackId);

  if (stackQuery.isLoading) {
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <Skeleton className="skeleton" />
        <div className="panel" style={{ padding: 24 }}><Skeleton className="skeleton" /></div>
        <div className="panel" style={{ padding: 24 }}><Skeleton className="skeleton" /></div>
      </div>
    );
  }

  if (!stack) {
    return (
      <div className="panel">
        <EmptyState
          icon={<Layers size={20} />}
          title="Stack not found"
          description="It may have been removed, moved, or renamed outside Cetus. Run a folder scan from the stacks page."
          action={<Link to="/stacks" className="btn btn-primary">Back to stacks</Link>}
        />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, color: "var(--muted)", fontSize: 12 }}>
        <Link to="/stacks" className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }}>
          <ArrowLeft size={14} /> Stacks
        </Link>
        <ChevronRight size={12} />
        <span className="mono">{stack.name}</span>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, justifyContent: "space-between", flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 26, fontWeight: 650, letterSpacing: "-0.045em" }}>{stack.displayName}</h2>
            <StatusBadge status={stack.status} />
            <Link to="/hosts/$hostId" params={{ hostId: stack.hostId }} className="badge" style={{ textDecoration: "none" }}>
              <Server size={11} /> {stack.hostName}
              {stack.hostKind === "worker" ? <span style={{ color: "var(--muted-2)" }}>worker</span> : null}
            </Link>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 7, color: "var(--muted)", fontSize: 12 }}>
            <span className="mono">{stack.name}</span>
            <span>·</span>
            <span>{stack.serviceCount} services</span>
            {stack.tags.map((tag) => <span className="chip" key={tag}>{tag}</span>)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Button
            variant="primary"
            onClick={deploy}
            loading={canDeploy && action.isPending}
            disabled={!canDeploy}
            aria-disabled={!canDeploy}
            title={canDeploy ? undefined : scopeReason("stacks:deploy")}
          >
            <Rocket size={14} /> Deploy
          </Button>
          <Button
            onClick={() => openEditor("compose")}
            disabled={stack.hostKind === "worker" || !canWrite}
            aria-disabled={stack.hostKind === "worker" || !canWrite}
            title={
              stack.hostKind === "worker"
                ? "Remote compose editing arrives with the worker file channel"
                : !canWrite
                  ? scopeReason("stacks:write")
                  : undefined
            }
          >
            <Pencil size={14} /> Edit compose
          </Button>
          {!canWrite || stack.hostKind === "worker" ? (
            <Button
              onClick={() => openEditor("compose", true)}
              title="Open the stack files read-only"
            >
              <Eye size={14} /> View files
            </Button>
          ) : null}
          <IconButton label="More stack actions" onClick={() => setMoreOpen(true)}>
            <MoreHorizontal size={16} />
          </IconButton>
        </div>
      </div>

      <div className="surface-soft" style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", padding: "9px 12px", marginBottom: 14, fontSize: 12 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <StatusDot status={stack.status} /> <strong>{stack.runningCount}/{stack.serviceCount}</strong> <span className="muted">running</span>
        </span>
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          title={stack.updateCheck ? `Checked ${formatDate(stack.updateCheck.checkedAt)}` : "No registry check has run yet."}
        >
          <RefreshCw size={12} className={updateCheck.isPending ? "animate-spin" : "muted"} />
          <span className="muted">Updates</span>
          <span>
            {stack.updateCheck
              ? stack.updateAvailable
                ? `${stack.updateCheck.services.filter((service) => service.updateAvailable).length} available`
                : updateErrors
                  ? `${updateErrors} unchecked`
                  : "current"
              : "not checked"}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ padding: 0, width: "auto", fontSize: 10.5 }}
            onClick={() => void runUpdateCheck()}
            disabled={updateCheck.isPending}
            title="Compare running image digests with the registry"
          >
            Check
          </button>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Clock3 size={12} className="muted" /> <span className="muted">Last deploy</span> <span>{relativeTime(stack.lastDeployedAt)}</span>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <FileCode2 size={12} className="muted" />
          <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>{stack.dir}/{stack.composeFile}</span>
          <button className="btn btn-ghost btn-sm" style={{ padding: 0, width: 24 }} onClick={() => copy(`${stack.dir}/${stack.composeFile}`, "Path copied")} aria-label="Copy compose path"><Copy size={11} /></button>
        </span>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="muted">Auto-update</span>
          <button
            type="button"
            className="auto-update-chip"
            data-on={stack.metadata.autoUpdate?.enabled ?? false}
            onClick={() => setAutoUpdateOpen(true)}
            disabled={!canWrite}
            title={canWrite ? "Configure auto-update" : scopeReason("stacks:write")}
          >
            <RefreshCw size={11} />
            {stack.metadata.autoUpdate?.enabled ? "Scheduled" : "Off"}
          </button>
        </span>
      </div>

      {operationId && operation.data ? (
        <div className="surface" style={{ marginBottom: 14, borderColor: operation.data.status === "failed" ? "var(--danger)" : "var(--accent-line)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
            <StatusDot status={operation.data.status} />
            <strong style={{ fontSize: 12 }}>{titleCase(operation.data.type)}</strong>
            <span className="muted" style={{ fontSize: 12 }}>{operation.data.status === "running" ? "running..." : operation.data.status}</span>
            <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>{shortId(operation.data.id)}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setOperationId(null)} aria-label="Dismiss operation"><X size={13} /></button>
          </div>
          <pre className="log-view" style={{ minHeight: 0, maxHeight: 140, padding: "9px 12px" }}>
            {operation.data.output.slice(-4000) || "Waiting for output..."}
          </pre>
        </div>
      ) : null}

      {editorOpen ? (
        <>
        <div className="editor-shell">
          <div className="editor-toolbar">
            <div className="tabs">
              {([
                ["compose", "compose.yaml"],
                ["env", ".env"],
                ["metadata", "cetus.json"],
              ] as const).map(([key, label]) => (
                <button key={key} className="tab" data-active={editorTab === key} onClick={() => setEditorTab(key)}>
                  {key === "env" && envRedacted ? <LockKeyhole size={13} /> : <FileCode2 size={13} />} {label}
                  {key === "compose" && dirty ? <span className="status-dot" data-status="partial" /> : null}
                </button>
              ))}
            </div>
            <span style={{ marginLeft: "auto", color: dirty ? "var(--warn)" : "var(--muted)", fontSize: 11 }}>
              {editorReadOnly ? "Read-only" : dirty ? "Unsaved changes" : "Saved"}
            </span>
            <Button
              variant="primary"
              onClick={deploy}
              loading={!editorReadOnly && (action.isPending || save.isPending)}
              disabled={editorReadOnly || !canDeploy}
              aria-disabled={editorReadOnly || !canDeploy}
              title={
                editorReadOnly
                  ? stack.hostKind === "worker"
                    ? "Remote compose editing is not supported yet"
                    : scopeReason("stacks:write")
                  : !canDeploy
                    ? scopeReason("stacks:deploy")
                    : undefined
              }
            >
              <Rocket size={14} /> Save and deploy
            </Button>
            <Button
              onClick={saveFiles}
              loading={!editorReadOnly && save.isPending}
              disabled={editorReadOnly || !canWrite}
              aria-disabled={editorReadOnly || !canWrite}
              title={
                editorReadOnly
                  ? stack.hostKind === "worker"
                    ? "Remote compose editing is not supported yet"
                    : scopeReason("stacks:write")
                  : !canWrite
                    ? scopeReason("stacks:write")
                    : undefined
              }
            >
              <Save size={14} /> Save draft
            </Button>
            <Button variant="ghost" onClick={() => setSnapshotsOpen(true)}>
              <History size={14} /> Snapshots
            </Button>
            <IconButton label="Close editor" onClick={() => setEditorOpen(false)}><X size={16} /></IconButton>
          </div>

          {localYamlError && editorTab === "compose" ? (
            <div style={{ display: "flex", gap: 8, padding: "8px 12px", background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12, borderBottom: "1px solid var(--border)" }}>
              <TriangleAlert size={14} /> {localYamlError}
            </div>
          ) : null}

          <div className="editor-grid">
            <aside className="editor-files">
              <div className="command-group">Stack files</div>
              <button
                type="button"
                className="command-item"
                data-active={editorTab === "compose"}
                style={{ width: "100%" }}
                onClick={() => setEditorTab("compose")}
              >
                <FileCode2 size={13} /> {stack.composeFile}
              </button>
              <button
                type="button"
                className="command-item"
                data-active={editorTab === "env"}
                style={{ width: "100%" }}
                onClick={() => setEditorTab("env")}
              >
                <Braces size={13} /> .env {envRedacted ? <LockKeyhole size={11} /> : null}
              </button>
              <button
                type="button"
                className="command-item"
                data-active={editorTab === "metadata"}
                style={{ width: "100%" }}
                onClick={() => setEditorTab("metadata")}
              >
                <Settings2 size={13} /> cetus.json
              </button>
              <div className="command-group" style={{ marginTop: 14 }}>Actions</div>
              <button className="command-item" style={{ width: "100%" }} onClick={() => setSnapshotsOpen(true)}><History size={13} /> Snapshots <small>{stack.snapshots.length}</small></button>
              <button className="command-item" style={{ width: "100%" }} onClick={() => setMoreOpen(true)}><MoreHorizontal size={13} /> Stack actions</button>
            </aside>
            <div className="editor-body">
              {editorTab === "compose" ? (
                <YamlEditor value={composeText} onChange={updateCompose} readOnly={editorReadOnly} />
              ) : editorTab === "env" && envRedacted ? (
                <div className="env-locked" role="status">
                  <span className="env-locked-icon"><LockKeyhole size={18} /></span>
                  <div>
                    <strong>Environment is locked</strong>
                    <p>
                      This session does not hold <code className="mono">secrets:reveal</code>. The .env file is withheld,
                      and saving from this editor leaves it untouched.
                    </p>
                  </div>
                </div>
              ) : editorTab === "env" ? (
                <textarea
                  className="textarea"
                  style={{ minHeight: "min(62vh, 760px)", border: 0, borderRadius: 0, padding: 14, background: "#060a0e", color: "#c8d6df" }}
                  value={envText}
                  readOnly={editorReadOnly}
                  onChange={(event) => {
                    setEnvText(event.target.value);
                    setDirty(true);
                  }}
                  spellCheck={false}
                />
              ) : (
                <textarea
                  className="textarea"
                  style={{ minHeight: "min(62vh, 760px)", border: 0, borderRadius: 0, padding: 14, background: "#060a0e", color: "#c8d6df" }}
                  value={metadataText}
                  readOnly={editorReadOnly}
                  onChange={(event) => {
                    setMetadataText(event.target.value);
                    setDirty(true);
                  }}
                  spellCheck={false}
                />
              )}
            </div>
          </div>
        </div>
        <div className="stack-editor-logs">
          <StackLogs
            stackId={stackId}
            hostId={stack.hostId}
            stackName={stack.name}
            services={stack.services}
            compact
            remote={remoteStack}
          />
        </div>
        </>
      ) : (
        <div className="stack-layout">
          <div className="stack-main">
            <section className="panel">
              <div className="panel-header">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Layers size={15} color="var(--accent)" />
                  <h3>Services</h3>
                  <Badge>{stack.services.length}</Badge>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => openEditor("compose")}
                    disabled={stack.hostKind === "worker" || !canWrite}
                    aria-disabled={stack.hostKind === "worker" || !canWrite}
                    title={
                      stack.hostKind === "worker"
                        ? "Remote editing not enabled yet"
                        : !canWrite
                          ? scopeReason("stacks:write")
                          : undefined
                    }
                  >
                    <Code2 size={13} /> Config
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setLogsService(null); setDockTab("logs"); }}><ScrollText size={13} /> Logs</button>
                </div>
              </div>
              <div className="table-wrap" style={{ borderRadius: 0 }}>
                <table className="data-table" aria-label={`Services in ${stack.displayName}`}>
                  <thead>
                    <tr>
                      <th scope="col">State</th>
                      <th scope="col">Service</th>
                      <th scope="col">Image</th>
                      <th scope="col">Ports</th>
                      <th scope="col">CPU / memory</th>
                      <th scope="col">Uptime</th>
                      <th scope="col"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {stack.services.map((service) => (
                      <ServiceRow
                        key={service.name}
                        service={service}
                        selected={selected?.name === service.name}
                        canDeploy={canDeploy}
                        canExec={canExec}
                        remote={remoteStack}
                        onSelect={() => setSelectedService(service.name)}
                        onAction={(action) => runServiceAction(service.name, action)}
                        onLogs={() => openServiceLogs(service.name)}
                        onConsole={() => {
                          setSelectedService(service.name);
                          setConsoleService(service.name);
                          setDockTab("console");
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="dock" ref={dockRef}>
              <div className="dock-header">
                <div className="tabs">
                  {([
                    ["logs", "Logs", ScrollText],
                    ["events", "Events", History],
                    ["stats", "Stats", Cpu],
                    ["console", "Console", Terminal],
                  ] as const).map(([key, label, Icon]) => {
                    const blocked = key === "console" && (remoteStack || !canExec);
                    const reason = remoteStack
                      ? "Remote exec is not supported yet"
                      : scopeReason("containers:exec");
                    return (
                      <button
                        key={key}
                        className="tab"
                        data-active={dockTab === key}
                        onClick={() => setDockTab(key)}
                        disabled={blocked}
                        aria-disabled={blocked}
                        title={blocked ? reason : undefined}
                      >
                        <Icon size={12} /> {label}
                      </button>
                    );
                  })}
                </div>
                <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 10.5 }}>
                  {dockTab === "console" ? "NON-INTERACTIVE" : selected?.name ?? stack.name}
                </span>
              </div>
              {dockTab === "logs" ? (
                <StackLogs
                  stackId={stackId}
                  hostId={stack.hostId}
                  stackName={stack.name}
                  services={stack.services}
                  compact
                  remote={remoteStack}
                  selectedService={logsService}
                  onSelectService={setLogsService}
                />
              ) : null}
              {dockTab === "events" ? (
                <div style={{ padding: "8px 14px", maxHeight: 280, overflow: "auto" }}>
                  <div className="timeline">
                    {[...stackOperations.map((op) => ({
                      id: op.id,
                      title: `${titleCase(op.type)} ${op.status}`,
                      detail: op.actorName,
                      time: op.startedAt,
                      tone: op.status === "success" ? "success" : op.status === "failed" ? "danger" : "accent",
                    })), ...(audit.data ?? []).map((entry) => ({
                      id: entry.id,
                      title: entry.action,
                      detail: entry.actorName,
                      time: entry.createdAt,
                      tone: entry.action.includes("delete") ? "danger" : entry.action.includes("save") ? "warn" : "accent",
                    }))].slice(0, 24).map((item) => (
                      <div className="timeline-item" key={item.id}>
                        <span className="timeline-dot" data-tone={item.tone} />
                        <div className="timeline-body">
                          <strong>{item.title}</strong>
                          <div className="timeline-time">{item.detail} · {relativeTime(item.time)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {stackOperations.length === 0 && (audit.data ?? []).length === 0 ? (
                    <div className="muted" style={{ padding: 20, textAlign: "center" }}>No events yet.</div>
                  ) : null}
                </div>
              ) : null}
              {dockTab === "stats" ? (
                <div style={{ padding: 14, display: "grid", gap: 12 }}>
                  {stack.services.map((service) => (
                    <div key={service.name} style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr) 110px", alignItems: "center", gap: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <StatusDot status={service.state} />
                        <span style={{ fontSize: 12 }}>{service.name}</span>
                      </div>
                      <div style={{ display: "grid", gap: 4 }}>
                        <div className="progress" data-tone={service.state === "running" ? "success" : "warn"}>
                          <span style={{ width: `${Math.min(100, service.cpu ?? 0)}%` }} />
                        </div>
                        <div className="progress">
                          <span style={{ width: `${service.memoryLimit ? ((service.memoryUsed ?? 0) / service.memoryLimit) * 100 : 0}%` }} />
                        </div>
                      </div>
                      <div style={{ textAlign: "right", fontSize: 11, color: "var(--muted)" }}>
                        <div>{formatPercent(service.cpu)} CPU</div>
                        <div>{formatBytes(service.memoryUsed)} RAM</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {dockTab === "console" ? (
                <div style={{ padding: 12 }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <select className="select" value={consoleService} onChange={(event) => setConsoleService(event.target.value)} style={{ width: 200 }}>
                      {stack.services.map((service) => <option key={service.name} value={service.name}>{service.name}</option>)}
                    </select>
                    <Input
                      className="input"
                      value={consoleCommand}
                      onChange={(event) => setConsoleCommand(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") runConsole(); }}
                      placeholder="Command to run inside the service"
                      style={{ flex: 1 }}
                    />
                    <Button
                      variant="primary"
                      onClick={runConsole}
                      loading={consoleRunning}
                      disabled={remoteStack || !canExec}
                      aria-disabled={remoteStack || !canExec}
                      title={remoteStack ? "Remote exec is not supported yet" : !canExec ? scopeReason("containers:exec") : undefined}
                    >
                      <Play size={13} /> Run
                    </Button>
                  </div>
                  <pre className="log-view" style={{ minHeight: 140, maxHeight: 240 }}>
                    {consoleOutput || (remoteStack
                      ? "Remote exec is not supported yet."
                      : "Run a command inside a service container. This MVP console is non-interactive; the PTY terminal arrives with the worker protocol.")}
                  </pre>
                </div>
              ) : null}
            </section>
          </div>

          <aside className="inspector">
            <section className="panel">
              <div className="panel-header">
                <h3>{selected ? selected.name : "Service"}</h3>
                {selected ? <StatusBadge status={selected.state} /> : null}
              </div>
              <div className="panel-body">
                {selected ? (
                  <div style={{ display: "grid", gap: 16 }}>
                    <dl className="kv">
                      <dt>Image</dt><dd className="mono">{selected.image}</dd>
                      <dt>Container</dt><dd className="mono">{selected.containerName ?? "not created"}</dd>
                      <dt>Health</dt><dd>{selected.health === "none" ? "No healthcheck" : selected.health}</dd>
                      <dt>Uptime</dt><dd>{selected.uptime ?? "n/a"}</dd>
                      <dt>CPU</dt><dd>{formatPercent(selected.cpu)}</dd>
                      <dt>Memory</dt><dd>{formatBytes(selected.memoryUsed)}</dd>
                    </dl>
                    {selected.ports.length > 0 ? (
                      <div>
                        <div className="label">Ports</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {selected.ports.map((port) => (
                            remoteStack ? (
                              <span
                                key={`${port.published}-${port.target}`}
                                className="port-text"
                                title={`Published on ${stack.hostName}. Remote port links are not available.`}
                              >
                                :{port.published} → {port.target}/{port.protocol}
                              </span>
                            ) : (
                              <a key={`${port.published}-${port.target}`} className="port-link" href={`http://${window.location.hostname}:${port.published}`} target="_blank" rel="noreferrer">
                                :{port.published} → {port.target}/{port.protocol}
                              </a>
                            )
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Button
                        size="sm"
                        onClick={() => runServiceAction(selected.name, selected.state === "running" ? "restart" : "start")}
                        disabled={!canDeploy}
                        aria-disabled={!canDeploy}
                        title={canDeploy ? undefined : scopeReason("stacks:deploy")}
                      >
                        {selected.state === "running" ? <RotateCw size={13} /> : <Play size={13} />}
                        {selected.state === "running" ? "Restart" : "Start"}
                      </Button>
                      {selected.state === "running" ? (
                        <Button
                          size="sm"
                          onClick={() => runServiceAction(selected.name, "stop")}
                          disabled={!canDeploy}
                          aria-disabled={!canDeploy}
                          title={canDeploy ? undefined : scopeReason("stacks:deploy")}
                        >
                          <Square size={13} /> Stop
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setDockTab("console"); setConsoleService(selected.name); }}
                        disabled={remoteStack || !canExec}
                        aria-disabled={remoteStack || !canExec}
                        title={remoteStack ? "Remote exec is not supported yet" : !canExec ? scopeReason("containers:exec") : undefined}
                      >
                        <Terminal size={13} /> Console
                      </Button>
                    </div>
                    {selected.oneShot ? (
                      <div className="badge badge-warn" style={{ justifyContent: "center" }}><TriangleAlert size={11} /> One-shot service, excluded from stack health</div>
                    ) : null}
                  </div>
                ) : (
                  <div className="muted">Select a service to inspect it.</div>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h3>Stack facts</h3></div>
              <div className="panel-body">
                <dl className="kv">
                  <dt>Project</dt><dd className="mono">{stack.projectName}</dd>
                  <dt>Host</dt><dd>{stack.hostName} · {stack.hostKind}</dd>
                  <dt>Compose</dt><dd className="mono">{stack.composeFile}</dd>
                  <dt>Profiles</dt><dd>{stack.profiles.length ? stack.profiles.join(", ") : "none"}</dd>
                  <dt>Sidecar</dt><dd>{Object.keys(stack.metadata).length ? "cetus.json" : "not present"}</dd>
                  <dt>Snapshots</dt><dd>{stack.snapshots.length}</dd>
                  <dt>Updated</dt><dd>{formatDate(stack.updatedAt)}</dd>
                </dl>
                <div style={{ display: "flex", gap: 6, marginTop: 14, flexWrap: "wrap" }}>
                  <Button size="sm" variant="ghost" onClick={() => copy(stack.dir, "Stack path copied")}><Copy size={12} /> Copy path</Button>
                  <Button size="sm" variant="ghost" onClick={() => setSnapshotsOpen(true)}><History size={12} /> Snapshots</Button>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h3>Recent activity</h3></div>
              <div className="panel-body">
                <div className="timeline">
                  {(audit.data ?? []).slice(0, 5).map((entry) => (
                    <div className="timeline-item" key={entry.id}>
                      <span className="timeline-dot" data-tone={entry.action.includes("delete") ? "danger" : entry.action.includes("save") ? "warn" : "accent"} />
                      <div className="timeline-body">
                        <strong>{entry.action}</strong>
                        <div className="timeline-time">{entry.actorName} · {relativeTime(entry.createdAt)}</div>
                      </div>
                    </div>
                  ))}
                </div>
                {!audit.data?.length ? <div className="muted" style={{ fontSize: 12 }}>No activity yet.</div> : null}
              </div>
            </section>
          </aside>
        </div>
      )}

      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="Stack actions" footer={<Button variant="ghost" onClick={() => setMoreOpen(false)}>Close</Button>}>
        <div style={{ display: "grid", gap: 8 }}>
          <Button
            onClick={() => runAction("update")}
            disabled={!canDeploy}
            aria-disabled={!canDeploy}
            title={canDeploy ? undefined : scopeReason("stacks:deploy")}
          >
            <RefreshCw size={14} /> Pull and recreate
          </Button>
          <Button
            onClick={() => runAction("restart")}
            disabled={!canDeploy}
            aria-disabled={!canDeploy}
            title={canDeploy ? undefined : scopeReason("stacks:deploy")}
          >
            <RotateCw size={14} /> Restart stack
          </Button>
          <Button
            onClick={() => runAction("stop")}
            disabled={!canDeploy}
            aria-disabled={!canDeploy}
            title={canDeploy ? undefined : scopeReason("stacks:deploy")}
          >
            <Square size={14} /> Stop stack
          </Button>
          <Button
            onClick={() => runAction("down")}
            disabled={!canDeploy}
            aria-disabled={!canDeploy}
            title={canDeploy ? undefined : scopeReason("stacks:deploy")}
          >
            <Box size={14} /> Down, keep files
          </Button>
          <Button variant="ghost" onClick={() => { setMoreOpen(false); setSnapshotsOpen(true); }}><History size={14} /> View snapshots</Button>
          <Button
            variant="danger"
            disabled={stack.hostKind === "worker" || !canDelete}
            aria-disabled={stack.hostKind === "worker" || !canDelete}
            title={
              stack.hostKind === "worker"
                ? "Remote delete is not part of the first worker slice"
                : !canDelete
                  ? scopeReason("stacks:delete")
                  : undefined
            }
            onClick={() => { setMoreOpen(false); setDeleteOpen(true); }}
          >
            <Trash2 size={14} /> Delete stack
          </Button>
        </div>
      </Dialog>

      <Dialog open={snapshotsOpen} onClose={() => setSnapshotsOpen(false)} title="Compose snapshots" wide footer={<Button variant="ghost" onClick={() => setSnapshotsOpen(false)}>Close</Button>}>
        {stack.snapshots.length === 0 ? (
          <EmptyState icon={<History size={18} />} title="No snapshots yet" description="Every save and deploy creates a snapshot in .cetus/snapshots." />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {stack.snapshots.map((snapshot) => (
              <div key={snapshot.file} className="surface-soft" style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px" }}>
                <History size={14} color="var(--accent)" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="mono" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{snapshot.file}</div>
                  <div style={{ color: "var(--muted)", fontSize: 11 }}>{formatDate(snapshot.createdAt)} · {formatBytes(snapshot.size)}</div>
                </div>
                <Button
                  size="sm"
                  loading={!remoteStack && canWrite && restore.isPending}
                  disabled={remoteStack || !canWrite}
                  aria-disabled={remoteStack || !canWrite}
                  title={
                    remoteStack
                      ? "Remote snapshot restore is not supported yet"
                      : !canWrite
                        ? scopeReason("stacks:write")
                        : undefined
                  }
                  onClick={() => {
                    if (remoteStack || !canWrite) return;
                    restore.mutate(snapshot.file, {
                      onSuccess: () => {
                        toast.success("Snapshot restored", "A new snapshot of the previous state was saved first.");
                        setSnapshotsOpen(false);
                      },
                      onError: (error) => toast.error("Restore failed", error instanceof Error ? error.message : "Unknown error"),
                    });
                  }}
                >
                  Restore
                </Button>
              </div>
            ))}
          </div>
        )}
      </Dialog>

      <AutoUpdateDialog
        stack={stack}
        open={autoUpdateOpen}
        onClose={() => setAutoUpdateOpen(false)}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ["stack", stackId] });
          void queryClient.invalidateQueries({ queryKey: ["stacks"] });
        }}
        onStarted={(started) => {
          setOperationId(started.id);
          void queryClient.invalidateQueries({ queryKey: ["stack", stackId] });
        }}
      />

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete stack"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="danger" disabled={confirmName !== stack.name} onClick={confirmDelete}><Trash2 size={14} /> Delete</Button>
          </>
        }
      >
        <p style={{ marginTop: 0, color: "var(--text-soft)" }}>
          This runs <code className="mono">docker compose down</code> and moves <code className="mono">{stack.dir}</code> to Cetus trash. It does not permanently delete the folder.
        </p>
        <label className="label" htmlFor="confirm-name">Type <span className="mono">{stack.name}</span> to confirm</label>
        <Input id="confirm-name" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} autoComplete="off" />
      </Dialog>
    </div>
  );
}

function ServiceRow({
  service,
  selected,
  canDeploy,
  canExec,
  remote,
  onSelect,
  onAction,
  onLogs,
  onConsole,
}: {
  service: ServiceState;
  selected: boolean;
  canDeploy: boolean;
  canExec: boolean;
  remote: boolean;
  onSelect: () => void;
  onAction: (action: string) => void;
  onLogs: () => void;
  onConsole: () => void;
}) {
  const stateLabel = service.state === "running" ? "Running" : titleCase(service.state);
  const deployReason = canDeploy ? undefined : scopeReason("stacks:deploy");
  const consoleReason = remote ? "Remote exec is not supported yet" : canExec ? undefined : scopeReason("containers:exec");
  return (
    <tr
      data-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      style={{ cursor: "pointer" }}
    >
      <td data-label="State">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <StatusDot status={service.health !== "none" && service.health !== "healthy" ? service.health : service.state} />
          <span style={{ fontSize: 12 }}>{stateLabel}</span>
        </span>
      </td>
      <td data-label="Service">
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <strong style={{ fontWeight: 600 }}>{service.name}</strong>
          {service.oneShot ? <span className="badge badge-warn" style={{ fontSize: 9, minHeight: 18 }}>one-shot</span> : null}
        </div>
      </td>
      <td data-label="Image"><span className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>{service.image}</span></td>
      <td data-label="Ports">
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {service.ports.length ? service.ports.map((port) => (
            remote ? (
              <span
                key={`${port.published}-${port.target}`}
                className="port-text"
                title="Published on the remote host. Remote port links are not available."
              >
                :{port.published}
              </span>
            ) : (
              <a
                key={`${port.published}-${port.target}`}
                href={`http://${window.location.hostname}:${port.published}`}
                target="_blank"
                rel="noreferrer"
                className="port-link"
                onClick={(event) => event.stopPropagation()}
              >
                :{port.published} <ExternalLink size={9} />
              </a>
            )
          )) : <span className="muted" style={{ fontSize: 11 }}>none</span>}
        </div>
      </td>
      <td data-label="CPU / memory">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 11 }}>{formatPercent(service.cpu)}</span>
          <div className="progress" style={{ width: 38 }}><span style={{ width: `${Math.min(100, service.cpu ?? 0)}%` }} /></div>
          <span className="mono muted" style={{ fontSize: 10.5 }}>{formatBytes(service.memoryUsed)}</span>
        </div>
      </td>
      <td data-label="Uptime"><span className="muted" style={{ fontSize: 11 }}>{service.uptime ?? "n/a"}</span></td>
      <td data-label="Actions">
        <div className="service-row-actions" style={{ justifyContent: "flex-end" }}>
          <IconButton label={`Logs for ${service.name}`} onClick={(event) => { event.stopPropagation(); onLogs(); }}><ScrollText size={13} /></IconButton>
          <IconButton
            label={`Console for ${service.name}${consoleReason ? ` (${consoleReason})` : ""}`}
            disabled={Boolean(consoleReason)}
            aria-disabled={Boolean(consoleReason)}
            title={consoleReason ?? `Console for ${service.name}`}
            onClick={(event) => { event.stopPropagation(); onConsole(); }}
          >
            <Terminal size={13} />
          </IconButton>
          <IconButton
            label={`${service.state === "running" ? "Restart" : "Start"} ${service.name}${deployReason ? ` (${deployReason})` : ""}`}
            disabled={!canDeploy}
            aria-disabled={!canDeploy}
            title={deployReason ?? `${service.state === "running" ? "Restart" : "Start"} ${service.name}`}
            onClick={(event) => { event.stopPropagation(); onAction(service.state === "running" ? "restart" : "start"); }}
          >
            {service.state === "running" ? <RotateCw size={13} /> : <Play size={13} />}
          </IconButton>
          {service.state === "running" ? (
            <IconButton
              label={`Stop ${service.name}${deployReason ? ` (${deployReason})` : ""}`}
              disabled={!canDeploy}
              aria-disabled={!canDeploy}
              title={deployReason ?? `Stop ${service.name}`}
              onClick={(event) => { event.stopPropagation(); onAction("stop"); }}
            >
              <Square size={13} />
            </IconButton>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
