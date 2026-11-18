import React, { useMemo, useState } from "react";
import { Search, ShieldCheck } from "lucide-react";
import {
  BROWSER_LEVELS,
  CAPABILITY_DOMAINS,
  DIRECTOR_PLATFORM_MODEL,
  DIRECTOR_STUDIO_BLUEPRINT,
  EIGHT_STAGE_PIPELINE_SPEC,
  FEEDBACK_TELEMETRY_LOOPS,
  IMPLEMENTATION_PHASES,
  MCP_SERVERS,
  OPERATING_PRINCIPLES,
  SUPREME_HIERARCHY,
  TOOL_PERMISSION_LEVELS,
} from "../data/architectureBlueprint";
import { CapabilityImplementationStatus } from "../types/models";
import { StatusBadge, StatusTone } from "../components/StatusBadge";

type ArchTab = "hierarchy" | "domains" | "gateways" | "roadmap";

export const ArchitectureScreen: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ArchTab>("hierarchy");
  const [domainQuery, setDomainQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | CapabilityImplementationStatus
  >("ALL");

  const filteredDomains = useMemo(() => {
    const q = domainQuery.trim().toLowerCase();
    return CAPABILITY_DOMAINS.filter((d) => {
      const matchesStatus = statusFilter === "ALL" || d.status === statusFilter;
      const matchesQuery =
        !q ||
        d.id.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        d.summary.toLowerCase().includes(q);
      return matchesStatus && matchesQuery;
    });
  }, [domainQuery, statusFilter]);

  const statusTone = (status: CapabilityImplementationStatus): StatusTone => {
    if (status === "demo_fixture") return "info";
    if (status === "policy_gated") return "warn";
    return "bad";
  };

  const statusLabel = (status: CapabilityImplementationStatus): string => {
    if (status === "demo_fixture") return "Demo fixture";
    if (status === "policy_gated") return "Policy gated";
    return "Target blueprint";
  };

  return (
    <div className="space-y-6">
      {/* Header + Blueprint Honesty Notice */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
            Master AI Capability &amp; Infrastructure Architecture
          </h1>
          <p className="text-xs text-[#8D9AB3] mt-0.5 max-w-3xl">
            Canonical operational architecture for ST Production House: OWNER governance,
            FORGE engineering executive, HERMES fleet orchestration, 50 Independent Directors,
            and isolated 8-stage Director-owned production pipelines.
          </p>
        </div>
        <StatusBadge label="Target Blueprint Reference" tone="info" />
      </div>

      <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-xl px-4 py-3 flex items-start gap-2.5 text-xs text-[#E8EEF8]">
        <ShieldCheck className="w-4 h-4 text-[#22D3EE] shrink-0 mt-0.5" />
        <p className="leading-relaxed text-[#8D9AB3]">
          <span className="text-[#E8EEF8] font-semibold">
            Blueprint vs. Runtime Honesty:
          </span>{" "}
          This catalogue documents the updated target architecture. Listing a
          capability domain, MCP server, or Phase does not claim that it is
          currently deployed, connected, or production-verified in this sandbox.
        </p>
      </div>

      {/* Sub-Navigation Tabs */}
      <div
        role="tablist"
        aria-label="Architecture sections"
        className="flex flex-wrap gap-2 border-b border-[#1E2A40] pb-3"
      >
        {(
          [
            { id: "hierarchy", label: "Hierarchy & 15 Principles" },
            { id: "domains", label: "24 Domains (ST-01–ST-24)" },
            { id: "gateways", label: "Permissions, Browser & MCP" },
            { id: "roadmap", label: "Director Blueprint & Phases 0–15" },
          ] as { id: ArchTab; label: string }[]
        ).map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-3.5 py-1.5 rounded-lg border text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                isActive
                  ? "bg-[#4F8CFF]/15 border-[#4F8CFF] text-[#22D3EE] font-semibold"
                  : "bg-[#0D1420] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: Hierarchy & 15 Principles */}
      {activeTab === "hierarchy" && (
        <div className="space-y-6">
          <section className="space-y-3">
            <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
              Supreme Organizational Hierarchy
            </h2>
            <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl divide-y divide-[#1E2A40]">
              {SUPREME_HIERARCHY.map((layer) => (
                <div
                  key={layer.name}
                  className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3"
                >
                  <div className="space-y-1 max-w-3xl">
                    <div className="text-[11px] font-mono uppercase tracking-wider text-[#22D3EE]">
                      {layer.tier}
                    </div>
                    <div className="text-sm font-bold font-display text-[#E8EEF8]">
                      {layer.name}
                    </div>
                    <div className="text-xs font-medium text-[#8D9AB3]">
                      {layer.subtitle}
                    </div>
                    <p className="text-xs text-[#8D9AB3]/90 leading-relaxed pt-0.5">
                      {layer.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
                  Tier 3 · Director-Owned Teams (8-Stage Execution Pipeline)
                </h2>
                <p className="text-xs text-[#8D9AB3] mt-0.5">
                  Every Independent Director commands an isolated, sequential 8-stage pipeline from raw prompt to finalized master package.
                </p>
              </div>
              <StatusBadge label="50 Isolated Pipelines" tone="ok" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#1E2A40] text-[#8D9AB3]">
                    <th className="py-2 pr-3 font-semibold w-16">Stage</th>
                    <th className="py-2 pr-3 font-semibold w-52">Unit Name</th>
                    <th className="py-2 font-semibold">Core Function &amp; Deliverables</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E2A40]/70">
                  {EIGHT_STAGE_PIPELINE_SPEC.map((st) => (
                    <tr key={st.key}>
                      <td className="py-2.5 pr-3 font-mono font-bold text-[#22D3EE] tabular-nums">
                        {String(st.stage).padStart(2, "0")}
                      </td>
                      <td className="py-2.5 pr-3 font-semibold text-[#E8EEF8]">
                        {st.unit}
                      </td>
                      <td className="py-2.5 text-[#8D9AB3] leading-relaxed">
                        {st.deliverables}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {FEEDBACK_TELEMETRY_LOOPS.map((loop) => (
              <div
                key={loop.title}
                className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-2"
              >
                <div className="text-[11px] font-mono uppercase tracking-wider text-[#22D3EE]">
                  Feedback &amp; Telemetry Loop
                </div>
                <h3 className="text-sm font-bold font-display text-[#E8EEF8]">
                  {loop.title}
                </h3>
                <div className="text-xs font-mono text-[#34D399]">
                  {loop.route}
                </div>
                <p className="text-xs text-[#8D9AB3] leading-relaxed">
                  {loop.detail}
                </p>
              </div>
            ))}
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
              <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
                Engineering vs. Production Plane Separation
              </h2>
              <p className="text-xs text-[#8D9AB3]">
                Stopping a laptop, Chromebook, browser, or Codespace must never
                halt deployed production workflows.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-[#1E2A40] text-[#8D9AB3]">
                      <th className="py-2 pr-3 font-semibold">Engineering Plane</th>
                      <th className="py-2 font-semibold">Production Plane</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E2A40]/70 text-[#E8EEF8]">
                    <tr><td className="py-2 pr-3">GitHub repository</td><td className="py-2 text-[#22D3EE]">Deployed cloud services</td></tr>
                    <tr><td className="py-2 pr-3">Codespaces / local IDE</td><td className="py-2 text-[#22D3EE]">Persistent cloud workers</td></tr>
                    <tr><td className="py-2 pr-3">CI builds &amp; unit tests</td><td className="py-2 text-[#22D3EE]">Durable production queues</td></tr>
                    <tr><td className="py-2 pr-3">Developer credentials</td><td className="py-2 text-[#22D3EE]">Isolated Director vault secrets</td></tr>
                    <tr><td className="py-2 pr-3">Build artifacts</td><td className="py-2 text-[#22D3EE]">Verified media manifests &amp; receipts</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
              <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
                Governance Rule Precedence
              </h2>
              <p className="text-xs text-[#8D9AB3]">
                Lower layers can never weaken or override higher-layer security or
                Owner-reserved controls.
              </p>
              <ol className="space-y-1.5 text-xs text-[#E8EEF8] font-mono">
                <li className="py-1 border-b border-[#1E2A40]/70">01 · Owner constitution &amp; reserved powers</li>
                <li className="py-1 border-b border-[#1E2A40]/70">02 · Global ST security &amp; compliance policies</li>
                <li className="py-1 border-b border-[#1E2A40]/70">03 · HERMES executive delegation rules</li>
                <li className="py-1 border-b border-[#1E2A40]/70">04 · Director creative charters (M3 isolated)</li>
                <li className="py-1 border-b border-[#1E2A40]/70">05 · Team operating instructions</li>
                <li className="py-1 border-b border-[#1E2A40]/70">06 · Project &amp; production rules</li>
                <li className="py-1">07 · Individual task instructions</li>
              </ol>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
              15 Non-Negotiable Operating Principles
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {OPERATING_PRINCIPLES.map((p) => (
                <div
                  key={p.num}
                  className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-1.5"
                >
                  <div className="text-[11px] font-mono text-[#22D3EE] tabular-nums">
                    PRINCIPLE {String(p.num).padStart(2, "0")}
                  </div>
                  <div className="text-xs font-bold text-[#E8EEF8]">
                    {p.title}
                  </div>
                  <p className="text-xs text-[#8D9AB3] leading-relaxed">
                    {p.text}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* TAB 2: 24 Capability Domains */}
      {activeTab === "domains" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-[#8D9AB3] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={domainQuery}
                onChange={(e) => setDomainQuery(e.target.value)}
                placeholder="Filter ST-01..ST-24 by ID, domain, or capability..."
                className="w-full bg-[#0D1420] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-xl pl-10 pr-4 py-2 text-xs text-[#E8EEF8] placeholder-[#8D9AB3]/70 outline-none"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { id: "ALL", label: "All (24)" },
                  { id: "demo_fixture", label: "Demo fixture" },
                  { id: "policy_gated", label: "Policy gated" },
                  { id: "target_blueprint", label: "Target blueprint" },
                ] as { id: "ALL" | CapabilityImplementationStatus; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setStatusFilter(opt.id)}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                    statusFilter === opt.id
                      ? "bg-[#4F8CFF]/15 border-[#4F8CFF] text-[#22D3EE]"
                      : "bg-[#0D1420] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredDomains.map((dom) => (
              <div
                key={dom.id}
                className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-2 flex flex-col justify-between"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-mono font-bold text-[#22D3EE] tabular-nums">
                      {dom.id}
                    </span>
                    <StatusBadge
                      label={statusLabel(dom.status)}
                      tone={statusTone(dom.status)}
                    />
                  </div>
                  <h3 className="text-sm font-bold text-[#E8EEF8]">
                    {dom.title}
                  </h3>
                  <p className="text-xs text-[#8D9AB3] leading-relaxed">
                    {dom.summary}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: Permissions, Browser & MCP */}
      {activeTab === "gateways" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
                  Tool Permission Hierarchy (T0–T7)
                </h2>
                <StatusBadge label="Enforced by Gateway" tone="warn" />
              </div>
              <p className="text-xs text-[#8D9AB3]">
                An AI prompt instruction alone is never authorization. Every tool
                call passes explicit permission checks.
              </p>
              <div className="divide-y divide-[#1E2A40]/80">
                {TOOL_PERMISSION_LEVELS.map((lvl) => (
                  <div
                    key={lvl.code}
                    className="py-2 flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="font-mono font-bold text-[#22D3EE] w-7">
                        {lvl.code}
                      </span>
                      <span className="font-semibold text-[#E8EEF8]">
                        {lvl.label}
                      </span>
                    </div>
                    <span className="text-[#8D9AB3] text-right">
                      {lvl.example}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
                  Browser Intelligence Levels (B0–B5)
                </h2>
                <StatusBadge label="Isolated Profiles" tone="info" />
              </div>
              <p className="text-xs text-[#8D9AB3]">
                Separate browser sessions and credentials per Director. Untrusted
                web pages are treated strictly as data—never instructions.
              </p>
              <div className="divide-y divide-[#1E2A40]/80">
                {BROWSER_LEVELS.map((b) => (
                  <div
                    key={b.code}
                    className="py-2 flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="font-mono font-bold text-[#34D399] w-7">
                        {b.code}
                      </span>
                      <span className="font-semibold text-[#E8EEF8]">
                        {b.label}
                      </span>
                    </div>
                    <span className="text-[#8D9AB3] text-right">
                      {b.example}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
                  ST MCP Gateway &amp; 8 Domain MCP Servers
                </h2>
                <p className="text-xs text-[#8D9AB3] mt-0.5">
                  MCP standardizes transport (Tools, Resources, Prompts, Sampling,
                  Roots, Notifications) while ST enforces independent identity, rate
                  limits, and audit authorization.
                </p>
              </div>
              <StatusBadge label="Target Architecture" tone="bad" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
              {MCP_SERVERS.map((srv) => (
                <div
                  key={srv.name}
                  className="bg-[#101A2B] border border-[#1E2A40] rounded-lg p-3 space-y-1"
                >
                  <div className="text-xs font-bold font-mono text-[#22D3EE]">
                    {srv.name}
                  </div>
                  <p className="text-xs text-[#8D9AB3] leading-relaxed">
                    {srv.responsibility}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* TAB 4: Director Blueprint & Phases 0-15 */}
      {activeTab === "roadmap" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
                  18-Point Director Studio Blueprint
                </h2>
                <span className="text-xs font-mono text-[#22D3EE] tabular-nums">
                  Scale cap: 50 Studios
                </span>
              </div>
              <p className="text-xs text-[#8D9AB3]">
                Every new Director studio is provisioned from this uniform template
                while retaining strict creative &amp; credential ownership.
              </p>
              <ol className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-[#E8EEF8]">
                {DIRECTOR_STUDIO_BLUEPRINT.map((item, idx) => (
                  <li
                    key={item}
                    className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 flex items-center gap-2"
                  >
                    <span className="font-mono text-[11px] text-[#22D3EE] tabular-nums shrink-0">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <span className="truncate" title={item}>
                      {item}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3 h-fit">
              <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
                One Director = One Independent 6-Platform Brand
              </h2>
              <p className="text-xs text-[#8D9AB3]">
                Disconnected or unauthorized platform slots fail honestly—no
                cross-Director account substitution is ever allowed.
              </p>
              <div className="divide-y divide-[#1E2A40]/80">
                {DIRECTOR_PLATFORM_MODEL.map((p) => (
                  <div
                    key={p.platform}
                    className="py-2 flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="font-semibold text-[#34D399]">
                      {p.platform}
                    </span>
                    <span className="text-[#8D9AB3] text-right">{p.note}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
                Implementation Phases (0–15) &amp; Acceptance Gates
              </h2>
              <span className="text-xs text-[#8D9AB3]">
                Code existence alone does not close a phase; verification +
                evidence required.
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#1E2A40] text-[#8D9AB3]">
                    <th className="py-2 pr-3 font-semibold w-16">Phase</th>
                    <th className="py-2 pr-3 font-semibold">Priority Layer</th>
                    <th className="py-2 pr-3 font-semibold">Acceptance Outcome</th>
                    <th className="py-2 font-semibold text-right">Console State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E2A40]/70">
                  {IMPLEMENTATION_PHASES.map((ph) => (
                    <tr key={ph.phase}>
                      <td className="py-2.5 pr-3 font-mono font-bold text-[#22D3EE] tabular-nums">
                        P{String(ph.phase).padStart(2, "0")}
                      </td>
                      <td className="py-2.5 pr-3 font-semibold text-[#E8EEF8]">
                        {ph.title}
                      </td>
                      <td className="py-2.5 pr-3 text-[#8D9AB3]">
                        {ph.outcome}
                      </td>
                      <td className="py-2.5 text-right">
                        <StatusBadge
                          label={
                            ph.status === "baseline_audit"
                              ? "Audit documented"
                              : ph.status === "demo_modeled"
                              ? "Demo modeled"
                              : "Target phase"
                          }
                          tone={
                            ph.status === "baseline_audit"
                              ? "ok"
                              : ph.status === "demo_modeled"
                              ? "info"
                              : "warn"
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
