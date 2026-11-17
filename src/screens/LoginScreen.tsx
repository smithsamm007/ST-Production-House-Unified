import React, { useState } from "react";

interface LoginScreenProps {
  onLogin: (email: string, password: string) => string | null;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin }) => {
  const [email, setEmail] = useState("owner@stproduction.demo");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const err = onLogin(email, password);
    setError(err);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#070B12] px-4 py-10">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-[420px] bg-[#0D1420] border border-[#1E2A40] rounded-2xl p-7 shadow-2xl space-y-5"
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
          UI prototype backed by browser-local demo fixtures. No backend is
          connected: every value on this console is simulated until this app
          binds to the ST Production House control plane.
        </p>

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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@stproduction.demo"
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              autoComplete="current-password"
              className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3.5 py-2.5 text-sm text-[#E8EEF8] placeholder-[#8D9AB3]/60 outline-none transition-colors"
            />
          </div>
        </div>

        {error && (
          <div role="alert" className="text-xs text-[#F87171] font-medium">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="w-full h-11 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] font-bold text-sm transition-colors cursor-pointer"
        >
          Sign in
        </button>

        <p className="text-[11px] text-[#8D9AB3] leading-relaxed">
          Demo mode: any non-blank email and password opens this console. State
          is saved in browser storage and can be reset in Settings.
        </p>
      </form>
    </div>
  );
};
