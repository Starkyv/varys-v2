import { Button, Card, Input, Lock } from "@varys/ui";
import { type FormEvent, useEffect, useState } from "react";
import { type AuthMethods, fetchAuthMethods, signIn, signUp } from "../../lib/auth";
import styles from "./styles.module.scss";

type Mode = "signin" | "signup";

/** The official multi-color Google "G" mark (@varys/ui has no Google glyph). */
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

/**
 * The login screen — Varys's front door. Rendered by <SessionGate> when there's no
 * session. Which methods show is server-driven (`/auth-config` ← VARYS_AUTH_METHODS):
 * the email/password form and/or a "Continue with Google" button.
 */
export function Login() {
  const [methods, setMethods] = useState<AuthMethods>({ emailPassword: true, google: false });
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchAuthMethods().then((m) => {
      if (alive) setMethods(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === "signin"
          ? await signIn.email({ email, password })
          : await signUp.email({ email, password, name: name.trim() || email });
      // On success the session store updates and <SessionGate> swaps in the app — no
      // navigation needed here. On failure better-auth returns a structured error.
      if (res.error) {
        setError(res.error.message ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function swapMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function google() {
    setError(null);
    // Redirects to Google; on return the session is set and <SessionGate> shows the app.
    await signIn.social({ provider: "google", callbackURL: window.location.origin });
  }

  return (
    <div className={styles.screen}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <span className={styles.mark}>
            <Lock size={18} />
          </span>
          <span className={styles.wordmark}>Varys</span>
        </div>

        <Card className={styles.card}>
          <h1 className={styles.title}>
            {methods.emailPassword && mode === "signup" ? "Create your account" : "Sign in"}
          </h1>
          <p className={styles.subtitle}>
            {methods.emailPassword && mode === "signup"
              ? "Set up an account to get started."
              : "Welcome back — sign in to continue."}
          </p>

          {methods.emailPassword && (
            <form className={styles.form} onSubmit={submit}>
              {mode === "signup" && (
                <label className={styles.field}>
                  <span className={styles.label}>Name</span>
                  <Input
                    type="text"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                  />
                </label>
              )}

              <label className={styles.field}>
                <span className={styles.label}>Email</span>
                <Input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@datagenie.ai"
                />
              </label>

              <label className={styles.field}>
                <span className={styles.label}>Password</span>
                <Input
                  type="password"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </label>

              {error && (
                <div className={styles.error} role="alert">
                  {error}
                </div>
              )}

              <Button type="submit" variant="primary" fullWidth loading={busy}>
                {mode === "signin" ? "Sign in" : "Create account"}
              </Button>
            </form>
          )}

          {methods.emailPassword && methods.google && (
            <div className={styles.divider}>
              <span>or</span>
            </div>
          )}

          {methods.google && (
            <Button variant="secondary" fullWidth iconLeft={<GoogleIcon />} onClick={google}>
              Sign in with Google
            </Button>
          )}

          {!methods.emailPassword && error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}

          {methods.emailPassword && (
            <div className={styles.swap}>
              {mode === "signin" ? (
                <>
                  New to Varys?{" "}
                  <button type="button" className={styles.link} onClick={() => swapMode("signup")}>
                    Create an account
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{" "}
                  <button type="button" className={styles.link} onClick={() => swapMode("signin")}>
                    Sign in
                  </button>
                </>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
