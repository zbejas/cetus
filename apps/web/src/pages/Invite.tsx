import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Eye, EyeOff, KeyRound, LockKeyhole, ShieldCheck, Waves } from "lucide-react";
import { ApiError, api } from "../lib/api";
import { useInvite } from "../lib/queries";
import { formatDate, titleCase } from "../lib/format";
import { useToast } from "../components/Toast";
import { Badge, Button, Input } from "../components/ui";
import { Logo } from "../components/Logo";

export function InvitePage({ token }: { token: string }) {
  const invite = useInvite(token);
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (invite.data?.name) setName(invite.data.name);
  }, [invite.data?.name]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await api.acceptInvite(token, { name: name.trim(), password });
      toast.success("Account created", "Sign in with your new password.");
      navigate({ to: "/login" });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "This invite could not be accepted.");
    } finally {
      setLoading(false);
    }
  }

  if (invite.isLoading) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <Logo size={48} />
          <div className="skeleton" style={{ width: 160, height: 8 }} />
        </div>
      </div>
    );
  }

  if (invite.isError || !invite.data) {
    return (
      <div className="login-shell">
        <section className="login-brand" aria-label="Cetus introduction">
          <div className="login-wordmark">
            <Logo size={42} />
            <span>Cetus</span>
          </div>
          <div className="login-copy">
            <h1>This link has<br /><span>left the tide.</span></h1>
            <p>The invite is invalid, already used, or expired. Ask an admin for a fresh one.</p>
          </div>
          <div className="login-footer">
            <LockKeyhole size={13} />
            Invite links are one-time and expire after seven days.
          </div>
        </section>
        <section className="login-form-side">
          <div className="login-card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
              <div className="login-wordmark" style={{ fontSize: 16 }}>
                <Logo size={34} />
                <span>Cetus</span>
              </div>
              <Badge tone="warn">Invite closed</Badge>
            </div>
            <h2>Invite unavailable</h2>
            <p>{invite.error instanceof ApiError ? invite.error.message : "The invite is invalid or has expired."}</p>
            <Link to="/login" className="btn btn-primary btn-lg" style={{ width: "100%" }}>
              Back to sign in <ArrowRight size={15} />
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const details = invite.data;

  return (
    <div className="login-shell">
      <section className="login-brand" aria-label="Cetus invitation">
        <div className="login-wordmark">
          <Logo size={42} />
          <span>Cetus</span>
        </div>
        <div className="login-copy">
          <h1>Join the<br /><span>fleet.</span></h1>
          <p>
            You were invited by {details.invitedBy}. Set up your account and get access to the stacks and hosts your
            role covers.
          </p>
          <div className="login-points">
            <div className="login-point"><ShieldCheck size={16} color="var(--accent)" /> {titleCase(details.role)} access</div>
            <div className="login-point"><Waves size={16} color="var(--accent)" /> One account for the fleet</div>
            <div className="login-point"><KeyRound size={16} color="var(--accent)" /> Scoped by role from day one</div>
          </div>
        </div>
        <div className="login-footer">
          <LockKeyhole size={13} />
          Invite expires {formatDate(details.expiresAt)}. It can be used once.
        </div>
      </section>

      <section className="login-form-side">
        <div className="login-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
            <div className="login-wordmark" style={{ fontSize: 16 }}>
              <Logo size={34} />
              <span>Cetus</span>
            </div>
            <Badge tone="accent">{titleCase(details.role)}</Badge>
          </div>

          <h2>Create your account</h2>
          <p>Use the invited email and choose a password.</p>

          <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
            <input type="text" name="username" autoComplete="username" value={details.email} readOnly hidden />
            <div>
              <label className="label" htmlFor="invite-email">Email</label>
              <Input id="invite-email" type="email" value={details.email} readOnly autoComplete="email" />
            </div>
            <div>
              <label className="label" htmlFor="invite-name">Name</label>
              <Input
                id="invite-name"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
                autoComplete="name"
                maxLength={80}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="invite-password">Password</label>
              <div style={{ position: "relative" }}>
                <Input
                  id="invite-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  minLength={8}
                  maxLength={200}
                  required
                  style={{ paddingRight: 42 }}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ position: "absolute", right: 4, top: 3, width: 28, height: 28, padding: 0 }}
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="invite-confirm">Confirm password</label>
              <Input
                id="invite-confirm"
                name="confirm"
                type={showPassword ? "text" : "password"}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                maxLength={200}
                required
              />
            </div>

            {error ? (
              <div role="alert" style={{ padding: "9px 11px", borderRadius: 8, background: "var(--danger-soft)", border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)", color: "var(--danger)", fontSize: 12 }}>
                {error}
              </div>
            ) : null}

            <Button type="submit" variant="primary" size="lg" loading={loading} style={{ width: "100%", marginTop: 2 }}>
              Create account <ArrowRight size={15} />
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
