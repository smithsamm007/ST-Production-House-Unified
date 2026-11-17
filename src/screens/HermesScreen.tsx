import React, { useState } from "react";
import { Lock, Play, ShieldAlert } from "lucide-react";
import {
  DelegationPolicyItem,
  HermesDecision,
  OwnerAvailability,
} from "../types/models";
import { StatusBadge, StatusTone } from "../components/StatusBadge";

interface HermesScreenProps {
  decisions: HermesDecision[];
  ownerAvailability: OwnerAvailability;
  delegationPolicies: DelegationPolicyItem[];
  onChangeOwnerAvailability: (availability: OwnerAvailability) => void;
  onTogglePolicy: (policyId: string) => void;
  onEvaluateDelegation: (
    policyId: string,
    requestSummary: string,
    approvalWindowExpired: boolean
  ) => { outcome: string; detail: string; allowed: boolean };
}

export const HermesScreen: React.FC<HermesScreenProps> = ({
  decisions,
  ownerAvailability,
  delegationPolicies,
  onChangeOwnerAvailability,
  onTogglePolicy,
  onEvaluateDelegation,
}) => {
  const [selectedPolicyId, setSelectedPolicyId] = useState(
    delegationPolicies[6]?.id ?? delegationPolicies[0]?.id ?? "del-07"
  );
  const [requestSummary, setRequestSummary] = useState(
    "Publish Ward 7 Highlight Short #1 after approval timeout"
  );
  const [windowExpired, setWindowExpired] = useState(true);
  const [evalResult, setEvalResult] = useState<{
    outcome: string;
    detail: string;
    allowed: boolean;
  } | null>(null);

  const handleEvaluate = (e: React.FormEvent) => {
    e.preventDefault();
    const res = onEvaluateDelegation(
      selectedPolicyId,
      requestSummary,
      windowExpired
    );
    setEvalResult(res);
  };

  const dispositionLabel = (p: DelegationPolicyItem): string => {
    if (p.lockedOwnerOnly) return "Owner-only (locked)";
    if (p.disposition === "explicit_policy_only") {
      return p.delegatedWhenUnavailable
        ? "Delegated publishing policy"
        : "Owner approval required";
    }
    if (p.disposition === "hermes_within_limits") {
      return p.delegatedWhenUnavailable ? "Decide within limits" : "Paused";
    }
    return p.delegatedWhenUnavailable ? "HERMES Decide" : "Paused";
  };

  const dispositionTone = (p: DelegationPolicyItem): StatusTone => {
    if (p.lockedOwnerOnly) return "bad";
    if (!p.delegatedWhenUnavailable) return "warn";
    return "ok";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
            HERMES · Managing Director &amp; Delegated Authority
          </h1>
          <p className="text-xs text-[#8D9AB3] mt-0.5 max-w-3xl">
            Reports to Owner &amp; Munder Difflin / Michael. Coordinates independent
            Directors without overwriting their universes, memory, or credentials.
          </p>
        </div>

        {/* Owner Availability Toggle */}
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-1.5 flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => onChangeOwnerAvailability("available")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              ownerAvailability === "available"
                ? "bg-[#34D399]/15 text-[#34D399] border border-[#34D399]/40"
                : "text-[#8D9AB3] hover:text-[#E8EEF8] border border-transparent"
            }`}
          >
            Owner Available
          </button>
          <button
            type="button"
            onClick={() => onChangeOwnerAvailability("unavailable")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              ownerAvailability === "unavailable"
                ? "bg-[#FBBF24]/15 text-[#FBBF24] border border-[#FBBF24]/40"
                : "text-[#8D9AB3] hover:text-[#E8EEF8] border border-transparent"
            }`}
          >
            Owner Unavailable
          </button>
        </div>
      </div>

      {/* Authority Tiers + No Assumed Consent Rule */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-[#101A2B] border border-[#2C3D5E] rounded-xl p-5 space-y-2.5">
          <h2 className="text-sm font-bold font-display text-[#22D3EE]">
            HERMES Authority Matrix &amp; Boundaries
          </h2>
          <ul className="space-y-1.5 text-xs text-[#E8EEF8]">
            <li>
              <span className="font-semibold text-[#34D399]">
                Tier 1 (Autonomous):
              </span>{" "}
              Provider routing, bounded retry recovery, cache hits, emergency local
              slot fallback.
            </li>
            <li>
              <span className="font-semibold text-[#22D3EE]">
                Tier 2 (Policy Governed):
              </span>{" "}
              Production queue balancing, team capacity, quality refusal, budget
              ceilings.
            </li>
            <li>
              <span className="font-semibold text-[#FBBF24]">
                Tier 3 (Owner Required / Explicit Delegation):
              </span>{" "}
              Live social publishing, new paid spend, OAuth credential bindings,
              security rules, deletions.
            </li>
          </ul>
        </div>

        <div className="bg-[#0D1420] border border-[#FBBF24]/35 rounded-xl p-5 space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold text-[#FBBF24] uppercase tracking-wider">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            No Assumed Consent
          </div>
          <p className="text-xs text-[#E8EEF8] leading-relaxed">
            No response is not consent. An expired approval only activates
            delegated action when the exact decision type is explicitly delegated
            below—never for Owner-only boundaries.
          </p>
          <div className="text-[11px] font-mono text-[#8D9AB3] pt-1">
            Current state:{" "}
            <span
              className={
                ownerAvailability === "available"
                  ? "text-[#34D399] font-semibold"
                  : "text-[#FBBF24] font-semibold"
              }
            >
              {ownerAvailability.toUpperCase()}
            </span>
          </div>
        </div>
      </section>

      {/* Owner Unavailability Delegation Matrix */}
      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
              Owner Unavailability &amp; Delegated Decision Policy
            </h2>
            <p className="text-xs text-[#8D9AB3] mt-0.5">
              Toggle discretionary delegation permissions. Owner-only decisions are
              permanently locked against delegation.
            </p>
          </div>
          <StatusBadge label="12 Governance Categories" tone="info" />
        </div>

        <div className="divide-y divide-[#1E2A40]">
          {delegationPolicies.map((pol) => (
            <div
              key={pol.id}
              className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-[#E8EEF8]">
                    {pol.category}
                  </span>
                  {pol.lockedOwnerOnly && (
                    <Lock
                      className="w-3.5 h-3.5 text-[#F87171] shrink-0"
                      aria-label="Locked Owner-only"
                    />
                  )}
                </div>
                <p className="text-xs text-[#8D9AB3]">{pol.summary}</p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <StatusBadge
                  label={dispositionLabel(pol)}
                  tone={dispositionTone(pol)}
                />
                {!pol.lockedOwnerOnly && (
                  <button
                    type="button"
                    onClick={() => onTogglePolicy(pol.id)}
                    className="px-3 py-1.5 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#E8EEF8] transition-colors whitespace-nowrap cursor-pointer"
                  >
                    {pol.delegatedWhenUnavailable ? "Revoke" : "Delegate"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Interactive Delegation Gate Evaluator (Demo) */}
      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-4">
        <div>
          <h2 className="text-sm font-bold font-display text-[#E8EEF8]">
            Test HERMES Decision Gate (Demo Simulation)
          </h2>
          <p className="text-xs text-[#8D9AB3] mt-0.5">
            Verify how HERMES handles a decision request under current Owner
            availability and delegation rules.
          </p>
        </div>

        <form onSubmit={handleEvaluate} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[#8D9AB3] mb-1">
                Decision Category
              </label>
              <select
                value={selectedPolicyId}
                onChange={(e) => setSelectedPolicyId(e.target.value)}
                className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-xs text-[#E8EEF8] outline-none"
              >
                {delegationPolicies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.category} ({dispositionLabel(p)})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-[#8D9AB3] mb-1">
                Action Request Summary
              </label>
              <input
                type="text"
                value={requestSummary}
                onChange={(e) => setRequestSummary(e.target.value)}
                className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-xs text-[#E8EEF8] outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <label className="inline-flex items-center gap-2 text-xs text-[#E8EEF8] cursor-pointer">
              <input
                type="checkbox"
                checked={windowExpired}
                onChange={(e) => setWindowExpired(e.target.checked)}
                className="rounded border-[#2C3D5E] bg-[#101A2B] text-[#4F8CFF]"
              />
              Approval response window expired (no Owner reply)
            </label>

            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              Evaluate Delegation Rule
            </button>
          </div>
        </form>

        {evalResult && (
          <div
            className={`rounded-lg border p-3.5 text-xs space-y-1 ${
              evalResult.allowed
                ? "bg-[#34D399]/10 border-[#34D399]/35 text-[#E8EEF8]"
                : "bg-[#F87171]/10 border-[#F87171]/35 text-[#E8EEF8]"
            }`}
          >
            <div className="font-mono font-bold text-[#22D3EE]">
              Verdict: {evalResult.outcome}
            </div>
            <p className="text-[#E8EEF8]/90 leading-relaxed">
              {evalResult.detail}
            </p>
          </div>
        )}
      </section>

      {/* Recent Decisions & Triage Logs */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[#8D9AB3]">
          Recent Decisions &amp; Triage Logs
        </h2>

        <div className="space-y-3">
          {decisions.map((dec) => (
            <div
              key={dec.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-[#E8EEF8]">
                  {dec.topic}
                </h3>
                <StatusBadge label={dec.authorityTier} tone="info" />
              </div>

              <div className="text-xs font-semibold text-[#34D399]">
                Decision: {dec.decision}
              </div>

              <p className="text-xs text-[#8D9AB3]">
                Rationale: {dec.rationale}
              </p>

              <div className="text-[11px] font-mono text-[#8D9AB3] tabular-nums">
                Timestamp: {dec.timestamp}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
