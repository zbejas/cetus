import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Eye, EyeOff, Fingerprint, KeyRound, LockKeyhole, ShieldCheck, Waves } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useAuthConfig } from "../lib/queries";
import { Button, Input } from "../components/ui";
import { useToast } from "../components/Toast";
import { Logo } from "../components/Logo";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [oidcLoading, setOidcLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const authConfig = useAuthConfig();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.login(email.trim(), password);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      toast.success("Welcome back", "Your fleet is ready.");
      navigate({ to: "/" });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not sign in. Check the credentials and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function startOidc() {
    setError(null);
    setOidcLoading(true);
    try {
      const result = await api.startOidc();
      if (!result.url) throw new Error("The identity provider did not return a redirect URL.");
      window.location.assign(result.url);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Single sign-on could not start. Try again or use your password.");
      setOidcLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <section className="login-brand" aria-label="Cetus introduction">
        <div className="login-wordmark">
          <Logo size={42} />
          <span>Cetus</span>
          <span className="badge badge-accent" style={{ marginLeft: 4 }}>v0.1</span>
        </div>

        <div className="login-copy">
          <h1>Compose,<br /><span>without the ceremony.</span></h1>
          <p>
            A file-first control plane for every Compose stack on every host. No database-owned YAML.
            No inbound agent ports. No paid tier between you and your audit log.
          </p>
          <div className="login-points">
            <div className="login-point"><ShieldCheck size={16} color="var(--accent)" /> Scoped keys and a readable audit trail</div>
            <div className="login-point"><Waves size={16} color="var(--accent)" /> One fleet view across every Docker host</div>
            <div className="login-point"><KeyRound size={16} color="var(--accent)" /> MCP access under the same permission model</div>
          </div>
        </div>

        <div className="login-footer">
          <LockKeyhole size={13} />
          Files stay at /opt/stacks. Cetus is the control plane, not the owner.
        </div>
      </section>

      <section className="login-form-side">
        <div className="login-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
            <div className="login-wordmark" style={{ fontSize: 16 }}>
              <Logo size={34} />
              <span>Cetus</span>
            </div>
            <span className="badge"><span className="status-dot" data-status="online" /> self-hosted</span>
          </div>

          <h2>Sign in</h2>
          <p>Use your operator account to open the fleet.</p>

          {authConfig.data?.oidc ? (
            <>
              <Button
                type="button"
                size="lg"
                loading={oidcLoading}
                onClick={() => void startOidc()}
                style={{ width: "100%", marginBottom: 16 }}
              >
                <Fingerprint size={16} /> Continue with {authConfig.data.oidc.name}
              </Button>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, color: "var(--muted-2)", fontSize: 11 }}>
                <span style={{ height: 1, flex: 1, background: "var(--border)" }} />
                or use your password
                <span style={{ height: 1, flex: 1, background: "var(--border)" }} />
              </div>
            </>
          ) : null}

          <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
            <div>
              <label className="label" htmlFor="email">Email</label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <div style={{ position: "relative" }}>
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  required
                  style={{ paddingRight: 42 }}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ position: "absolute", right: 4, top: 3, width: 28, height: 28, padding: 0 }}
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {error ? (
              <div style={{ padding: "9px 11px", borderRadius: 8, background: "var(--danger-soft)", border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)", color: "var(--danger)", fontSize: 12 }}>
                {error}
              </div>
            ) : null}

            <Button type="submit" variant="primary" size="lg" loading={loading} style={{ width: "100%", marginTop: 2 }}>
              Enter fleet <ArrowRight size={15} />
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
