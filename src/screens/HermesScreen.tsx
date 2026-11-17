import React from "react";
import { HermesDecision } from "../types/models";
import { StatusBadge } from "../components/StatusBadge";

interface HermesScreenProps {
  decisions: HermesDecision[];
}

export const HermesScreen: React.FC<HermesScreenProps> = ({ decisions }) => {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Hermes · AI Production Manager
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Autonomous triage, authority matrix compliance, queue balancing, and
          provider failover coordination.
        </p>
      </div>

      {/* Authority Matrix Card */}
      <section className="bg-[#101A2B] border border-[#2C3D5E] rounded-xl p-5 space-y-2.5">
        <h2 className="text-sm font-bold font-display text-[#22D3EE]">
          Hermes Authority Matrix
        </h2>
        <ul className="space-y-1.5 text-xs text-[#E8EEF8]">
          <li>
            <span className="font-semibold text-[#34D399]">
              Tier 1 (Autonomous):
            </span>{" "}
            Provider routing, retry recovery, cache hits, emergency fallback
          </li>
          <li>
            <span className="font-semibold text-[#22D3EE]">
              Tier 2 (Policy Governed):
            </span>{" "}
            Production scheduling slots, reel generation reservations
          </li>
          <li>
            <span className="font-semibold text-[#FBBF24]">
              Tier 3 (Owner Required):
            </span>{" "}
            Live social publishing, budget expansions, credential changes
          </li>
        </ul>
      </section>

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
