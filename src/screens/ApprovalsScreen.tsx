import React from "react";
import { ApprovalItem } from "../types/models";
import { StatusBadge, StatusTone } from "../components/StatusBadge";

interface ApprovalsScreenProps {
  approvals: ApprovalItem[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

export const ApprovalsScreen: React.FC<ApprovalsScreenProps> = ({
  approvals,
  onApprove,
  onReject,
}) => {
  const getTone = (status: string): StatusTone => {
    if (status === "approved") return "ok";
    if (status === "rejected") return "bad";
    return "warn";
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Live Publishing Approvals (Rule 7)
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Live publishing requires an explicit, unexpired owner approval tied to
          the exact artifact hash, destination, caption, affiliate links, and
          disclosure.
        </p>
      </div>

      {approvals.length === 0 ? (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-10 text-center text-sm text-[#8D9AB3]">
          No publication approvals pending.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {approvals.map((item) => (
            <div
              key={item.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold font-display text-[#E8EEF8]">
                    {item.title}
                  </h2>
                  <p className="text-xs text-[#22D3EE] mt-0.5">
                    {item.channelName} · Destination: {item.destination}
                  </p>
                </div>
                <StatusBadge label={item.status} tone={getTone(item.status)} />
              </div>

              <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 font-mono text-[11px] text-[#8D9AB3] break-all select-all">
                Artifact Hash: {item.artifactHash}
              </div>

              <div className="space-y-1">
                <div className="text-xs font-semibold text-[#8D9AB3]">
                  Caption
                </div>
                <p className="text-sm text-[#E8EEF8]">{item.caption}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="font-semibold text-[#8D9AB3]">Disclosure</div>
                  <p className="text-[#E8EEF8] mt-0.5">{item.disclosure}</p>
                </div>
                <div>
                  <div className="font-semibold text-[#8D9AB3]">
                    Affiliate Links
                  </div>
                  <p className="text-[#E8EEF8] mt-0.5">{item.affiliateLinks}</p>
                </div>
              </div>

              {item.status === "pending" && (
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => onApprove(item.id)}
                    className="py-2.5 px-4 rounded-lg bg-[#34D399] hover:bg-[#29BA84] text-[#070B12] text-xs font-bold transition-colors cursor-pointer"
                  >
                    Approve for Live Release
                  </button>
                  <button
                    type="button"
                    onClick={() => onReject(item.id)}
                    className="py-2.5 px-4 rounded-lg border border-[#F87171]/50 hover:bg-[#F87171]/10 text-[#F87171] text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
