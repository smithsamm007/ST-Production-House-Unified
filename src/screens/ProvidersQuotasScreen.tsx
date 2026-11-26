import React, { useMemo } from "react";
import type { ProviderView } from "../types/ownerApi";
import type { DataSourceStatus } from "../types/dataState";
import { MetricCard, StatusBadge } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";

interface ProvidersQuotasScreenProps {
  providers: ProviderView[];
  status: DataSourceStatus;
  onRefresh: () => void;
}

/**
 * Provider catalog from GET /api/providers/catalog.
 *
 * The catalog is metadata only (official credential URLs, auth type,
 * capabilities). No latency or quota percentage exists in any route, so this
 * screen shows none — the previous demo percentages are gone rather than
 * replaced with plausible numbers.
 */
export const ProvidersQuotasScreen: React.FC<ProvidersQuotasScreenProps> = ({
  providers,
  status,
  onRefresh,
}) => {
  const connected = status.state === "live" || status.state === "stale";

  const byCategory = useMemo(() => {
    const groups = new Map<string, ProviderView[]>();
    for (const provider of providers) {
      const key = provider.category || "uncategorised";
      const bucket = groups.get(key) ?? [];
      bucket.push(provider);
      groups.set(key, bucket);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [providers]);

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Provider Catalog"
        subtitle="Governed provider metadata from the backend. Quota and latency telemetry is not exposed by any route, so it is not displayed."
        status={status}
        onRefresh={onRefresh}
      />

      {!connected ? (
        <DataSourceNotice status={status} title="provider catalog" onRetry={onRefresh} />
      ) : (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard label="Providers" value={providers.length} tone="info" />
            <MetricCard label="Categories" value={byCategory.length} tone="info" />
            <MetricCard
              label="API-key auth"
              value={providers.filter((provider) => provider.authType === "api_key").length}
              tone="ok"
            />
            <MetricCard
              label="OAuth auth"
              value={providers.filter((provider) => provider.authType === "oauth").length}
              tone="ok"
            />
          </section>

          {byCategory.map(([category, items]) => (
            <section key={category} className="space-y-3">
              <h2 className="text-xs font-bold tracking-wider uppercase text-[#22D3EE]">
                {category}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {items.map((provider) => (
                  <div
                    key={provider.providerKey}
                    className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-sm font-bold text-[#E8EEF8] truncate">
                          {provider.displayName}
                        </h3>
                        <p className="text-[11px] font-mono text-[#8D9AB3] truncate">
                          {provider.providerKey}
                        </p>
                      </div>
                      <StatusBadge label={provider.authType || "unknown"} tone="info" />
                    </div>

                    {provider.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {provider.capabilities.map((capability) => (
                          <span
                            key={capability}
                            className="px-2 py-0.5 rounded border border-[#1E2A40] bg-[#101A2B] text-[11px] text-[#E8EEF8]"
                          >
                            {capability}
                          </span>
                        ))}
                      </div>
                    )}

                    <p className="text-[11px] text-[#8D9AB3] border-t border-[#1E2A40] pt-2">
                      Quota usage and health are not reported by this backend.
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ))}

          <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-xl p-4 space-y-1.5">
            <h2 className="text-sm font-bold text-[#34D399]">
              Rule 17: Opaque Secrets &amp; Safe Serialization
            </h2>
            <p className="text-xs text-[#8D9AB3] leading-relaxed">
              Real API keys and tokens never reach the database or this browser. Connections store only
              secret-manager locators, and the API serializes an explicit allowlist.
            </p>
          </div>
        </>
      )}
    </div>
  );
};
