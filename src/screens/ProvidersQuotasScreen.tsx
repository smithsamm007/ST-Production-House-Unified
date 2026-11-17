import React from "react";
import { ProviderCategory, ProviderSlot } from "../types/models";
import { StatusBadge } from "../components/StatusBadge";

interface ProvidersQuotasScreenProps {
  providers: ProviderSlot[];
}

const CATEGORIES: ProviderCategory[] = [
  "Visual",
  "Narration",
  "Assembly",
  "Publisher",
];

export const ProvidersQuotasScreen: React.FC<ProvidersQuotasScreenProps> = ({
  providers,
}) => {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Provider Status &amp; Quota Ledger
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Rule 5 Contract: 3 private remote slots + 1 local open-source
          emergency slot per task policy. Never borrow cross-agent secrets.
        </p>
      </div>

      {CATEGORIES.map((category) => {
        const categoryProviders = providers.filter(
          (p) => p.category === category
        );
        return (
          <section key={category} className="space-y-3">
            <h2 className="text-xs font-bold tracking-wider uppercase text-[#22D3EE]">
              {category} Providers
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {categoryProviders.map((p) => {
                const highQuota = p.dailyQuotaUsedPercent > 80;
                return (
                  <div
                    key={p.id}
                    className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-[#E8EEF8]">
                          {p.name}
                        </h3>
                        <p className="text-xs text-[#22D3EE] mt-0.5">
                          {p.tier}
                        </p>
                      </div>
                      <StatusBadge
                        label={p.status}
                        tone={
                          p.status === "healthy"
                            ? "ok"
                            : p.status === "cooldown"
                            ? "warn"
                            : "bad"
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between text-xs tabular-nums">
                      <span className="font-mono text-[#8D9AB3]">
                        Latency: {p.latencyMs}ms
                      </span>
                      <span
                        className={`font-mono font-semibold ${
                          highQuota ? "text-[#FBBF24]" : "text-[#34D399]"
                        }`}
                      >
                        Daily Quota: {p.dailyQuotaUsedPercent}%
                      </span>
                    </div>

                    <div className="w-full h-1.5 rounded-full bg-[#1E2A40] overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          highQuota ? "bg-[#FBBF24]" : "bg-[#4F8CFF]"
                        }`}
                        style={{ width: `${p.dailyQuotaUsedPercent}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {/* Rule 17 Opaque Secrets Card */}
      <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-xl p-4 space-y-1.5">
        <h2 className="text-sm font-bold text-[#34D399]">
          Rule 17: Opaque Secrets &amp; Safe Serialization
        </h2>
        <p className="text-xs text-[#8D9AB3] leading-relaxed">
          Real API keys, tokens, or passwords are never stored in plain text.
          Secret manager URLs (<code className="text-[#22D3EE]">vault://stph-secrets/...</code>) are
          used with strict field allowlists (DTO).
        </p>
      </div>
    </div>
  );
};
