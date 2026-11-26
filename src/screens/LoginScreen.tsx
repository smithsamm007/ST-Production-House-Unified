import React, { useState } from "react";
import type { LoginResult } from "../store/useProductionStore";

interface LoginScreenProps {
  onLogin: (email: string, password: string) => Promise<LoginResult>;
  onVerifyTotp: (code: string) => Promise<LoginResult>;
  mfaRequired: boolean;
  busy: boolean;
  /** Session-level message from the store (expiry, backend unreachable…). */
  sessionError: string | null;
  sessionExpired: boolean;
}

/**
 * Real Owner authentication.
 *
 * Credentials go straight to POST /api/auth/login; the server sets the
 * HttpOnly session cookie and returns the per-session CSRF token, which is held
 * in memory by the API client. Nothing about the session is written to
 * localStorage, and no local flag can make this console look authenticated.
 */
export const LoginScreen: React.FC<LoginScreenProps> = ({
  onLogin,
  onVerifyTotp,
  mfaRequired,
  busy,
  sessionError,
  sessionExpired,
}) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const result = await onLogin(email, password);
    setError(result.error);
    if (!result.error) setPassword("");
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const result = await onVerifyTotp(totpCode);
    setError(result.error);
    if (!result.error) setTotpCode("");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#070B12] px-4 py-10">
      <div className="w-full max-w-[420px] space-y-4">
        <form
          onSubmit={mfaRequired ? handleMfaSubmit : handleSubmit}
          className="bg-[#0D1420] border border-[#1E2A40] rounded-2xl p-7 shadow-2xl space-y-5"
        >
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-[#101A2B] border border-[#2C3D5E] flex items-center justify-center font-display font-black text-xl text-[#22D3EE]">
              ST
            </div>
            <div>
              <h1 className="font-display font-bold text-base tracking-[0.15em] text-[#E8EEF8]">
                PRODUCTION HOUSE
              </h1>
              <p className="text-[11px] font-semibold tracking-[0.18em] text-[#8D9AB3] uppercase mt-0.5">
                Unified · Owner Console
              </p>
            </div>
          </div>

          <p className="text-xs text-[#8D9AB3] leading-relaxed">
            {mfaRequired
              ? "Multi-factor authentication is enabled for this Owner. Enter the current authenticator code to raise this session to high assurance."
              : "Sign in with your Owner credentials. This console is served by the ST Production House control plane: every value you see after sign-in comes from the authenticated PostgreSQL-backed API."}
          </p>

          {sessionExpired && (
            <div
              role="status"
              className="rounded-lg border border-[#FBBF24]/40 bg-[#FBBF24]/10 px-3 py-2 text-[11px] text-[#FBBF24]"
            >
              The previous session ended. Sign in again to continue.
            </div>
          )}

          {mfaRequired ? (
            <div>
              <label
                htmlFor="login-totp"
                className="block text-xs font-medium text-[#8D9AB3] mb-1.5"
              >
                Authenticator code
              </label>
              <input
                id="login-totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="123456"
                className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3.5 py-2.5 text-sm font-mono tracking-[0.3em] text-[#E8EEF8] placeholder-[#8D9AB3]/60 outline-none transition-colors"
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="login-email"
                  className="block text-xs font-medium text-[#8D9AB3] mb-1.5"
                >
                  Owner Email
                </label>
                <input
                  id="login-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="owner@example.com"
                  autoComplete="username"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3.5 py-2.5 text-sm text-[#E8EEF8] placeholder-[#8D9AB3]/60 outline-none transition-colors"
                />
              </div>

              <div>
                <label
                  htmlFor="login-password"
                  className="block text-xs font-medium text-[#8D9AB3] mb-1.5"
                >
                  Password
                </label>
                <input
                  id="login-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  autoComplete="current-password"
                  className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3.5 py-2.5 text-sm text-[#E8EEF8] placeholder-[#8D9AB3]/60 outline-none transition-colors"
                />
              </div>
            </div>
          )}

          {(error || sessionError) && (
            <div role="alert" className="text-xs text-[#F87171] font-medium leading-relaxed">
              {error ?? sessionError}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full h-11 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] disabled:opacity-60 text-[#070B12] font-bold text-sm transition-colors cursor-pointer"
          >
            {busy ? "Authenticating…" : mfaRequired ? "Verify code" : "Sign in"}
          </button>

          <p className="text-[11px] text-[#8D9AB3] leading-relaxed">
            Sessions use an HttpOnly cookie plus a per-session CSRF token held in
            memory. No password, session token or CSRF token is stored in this
            browser. The first signup bootstraps the Owner account; afterwards
            registration is closed by the backend.
          </p>
        </form>
      </div>
    </div>
  );
};
