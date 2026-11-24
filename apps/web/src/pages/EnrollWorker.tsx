import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Check, Copy, KeyRound, Server, ShieldCheck, Terminal } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useMe } from "../lib/queries";
import { useToast } from "../components/Toast";
import { Button, Input, PageHeader, Badge } from "../components/ui";
import { cn } from "../lib/format";

interface Enrollment {
  token: string;
  managerUrl: string;
  expiresAt: string;
}

export function EnrollWorkerPage() {
  const me = useMe();
  const toast = useToast();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const isAdmin = me.data?.user?.role === "admin";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await api.enrollHost(name.trim());
      setEnrollment(result);
      toast.success("Worker token created", "It expires in 15 minutes and can be used once.");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create an enrollment token.");
    } finally {
      setLoading(false);
    }
  }

  async function copy(value: string, key: string, label: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    toast.success(label, "Copied to clipboard.");
    window.setTimeout(() => setCopied(null), 2_000);
  }

  const workerCommand = enrollment
    ? `CETUS_MODE=worker \\
CETUS_MANAGER_URL=${enrollment.managerUrl} \\
CETUS_ENROLL_TOKEN=${enrollment.token} \\
CETUS_WORKER_NAME=${name || "worker"} \\
CETUS_WORKER_STACKS_DIR=/opt/stacks \\
CETUS_WORKER_DATA_DIR=/data \\
bun apps/server/src/worker.ts`
    : "";

  const composeSnippet = enrollment
    ? `services:
  cetus-worker:
    image: ghcr.io/zbejas/cetus:latest
    restart: unless-stopped
    environment:
      CETUS_MODE: worker
      CETUS_MANAGER_URL: ${enrollment.managerUrl}
      CETUS_ENROLL_TOKEN: ${enrollment.token}
      CETUS_WORKER_NAME: ${name || "worker"}
      CETUS_WORKER_STACKS_DIR: /opt/stacks
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
      - /opt/stacks:/opt/stacks
`
    : "";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, color: "var(--muted)", fontSize: 12 }}>
        <Link to="/" className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }}>
          <ArrowLeft size={14} /> Fleet
        </Link>
        <span>/</span>
        <span>Worker enrollment</span>
      </div>

      <PageHeader
        title="Add a worker"
        description="Enroll a remote Docker host. The worker dials out, so the host needs no inbound ports."
        actions={<Badge tone="accent"><ShieldCheck size={11} /> one-time token</Badge>}
      />

      {!isAdmin ? (
        <div className="panel" style={{ padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--warn)" }}>
            <KeyRound size={16} /> Admin scope is required to create enrollment tokens.
          </div>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section className="panel">
            <div className="panel-header">
              <h3>1. Name the host</h3>
              <Server size={15} color="var(--accent)" />
            </div>
            <div className="panel-body">
              <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
                <div>
                  <label className="label" htmlFor="worker-name">Worker name</label>
                  <Input
                    id="worker-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="lxc-media"
                    required
                    pattern="[a-zA-Z0-9._-]+"
                    maxLength={80}
                  />
                  <div className="help">Used for the host chip and audit trail. A random suffix keeps slugs unique.</div>
                </div>

                {error ? (
                  <div style={{ padding: "9px 11px", borderRadius: 8, background: "var(--danger-soft)", border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)", color: "var(--danger)", fontSize: 12 }}>
                    {error}
                  </div>
                ) : null}

                <Button type="submit" variant="primary" loading={loading} disabled={!name.trim()}>
                  <KeyRound size={14} /> Create enrollment token
                </Button>
              </form>

              <div className="surface-soft" style={{ padding: 12, marginTop: 16, color: "var(--muted)", fontSize: 12, lineHeight: 1.55 }}>
                The token is single use and expires after 15 minutes. The worker exchanges it for a host ID and a
                long-lived worker secret stored in its data directory. The token is never stored in the manager after enrollment.
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>2. Run the worker</h3>
              <Terminal size={15} color="var(--accent)" />
            </div>
            <div className="panel-body">
              {enrollment ? (
                <div style={{ display: "grid", gap: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Badge tone="success"><Check size={11} /> ready</Badge>
                    <span className="muted" style={{ fontSize: 11 }}>expires {new Date(enrollment.expiresAt).toLocaleTimeString()}</span>
                  </div>

                  <div>
                    <div className="label">Bare Bun worker</div>
                    <div className="surface-soft" style={{ position: "relative", padding: 12, background: "#060a0e" }}>
                      <pre className="mono" style={{ margin: 0, fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#c8d6df" }}>{workerCommand}</pre>
                      <button className="btn btn-sm" style={{ position: "absolute", right: 8, top: 8 }} onClick={() => copy(workerCommand, "command", "Command copied")}>
                        {copied === "command" ? <Check size={12} /> : <Copy size={12} />} Copy
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="label">Container recipe</div>
                    <div className="surface-soft" style={{ position: "relative", padding: 12, background: "#060a0e" }}>
                      <pre className="mono" style={{ margin: 0, fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#c8d6df" }}>{composeSnippet}</pre>
                      <button className="btn btn-sm" style={{ position: "absolute", right: 8, top: 8 }} onClick={() => copy(composeSnippet, "compose", "Compose snippet copied")}>
                        {copied === "compose" ? <Check size={12} /> : <Copy size={12} />} Copy
                      </button>
                    </div>
                  </div>

                  <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.55 }}>
                    After the worker connects, it appears on the overview and in the stacks table. Compose edits,
                    delete, container actions, deploy, lifecycle, inventory, and logs work over the worker channel.
                    Remote exec, snapshot restore, and interactive terminals are not part of this slice.
                  </div>
                </div>
              ) : (
                <div className="empty-state" style={{ minHeight: 220 }}>
                  <div className="empty-state-icon"><Terminal size={20} /></div>
                  <h3>No token yet</h3>
                  <p>Create a token on the left. The exact command and compose recipe will appear here.</p>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
