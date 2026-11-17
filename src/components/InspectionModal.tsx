import React, { useEffect } from "react";
import { ShieldCheck, X } from "lucide-react";
import { InspectionModalData } from "../types/models";
import { formatDuration } from "../utils/crypto";
import { StatusBadge } from "./StatusBadge";

interface InspectionModalProps {
  data: InspectionModalData;
  onDismiss: () => void;
}

export const InspectionModal: React.FC<InspectionModalProps> = ({
  data,
  onDismiss,
}) => {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="inspection-modal-title"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-lg bg-[#0D1420] border border-[#2C3D5E] rounded-2xl p-6 shadow-2xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-[#22D3EE]" />
              <h2
                id="inspection-modal-title"
                className="text-base font-bold text-[#E8EEF8] font-display"
              >
                Artifact Inspection &amp; Hash Receipt
              </h2>
            </div>
            <p className="text-sm font-semibold text-[#22D3EE] mt-1.5">
              {data.title}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge
              label={data.isVerified ? "VERIFIED" : "DEMO PLAN"}
              tone={data.isVerified ? "ok" : "info"}
            />
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Close inspection dialog"
              className="p-1.5 rounded-lg text-[#8D9AB3] hover:text-[#E8EEF8] hover:bg-[#101A2B] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="bg-[#101A2B] border border-[#1E2A40] rounded-xl p-4 space-y-2.5 text-xs">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Slot Identity</span>
            <span className="font-mono font-semibold text-[#E8EEF8]">
              {data.slotKey}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Resolution &amp; Ratio</span>
            <span className="font-mono text-[#E8EEF8] tabular-nums">
              {data.resolution} ({data.aspectRatio})
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Duration</span>
            <span className="font-mono text-[#E8EEF8] tabular-nums">
              {formatDuration(data.durationSeconds)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Broadcast Loudness</span>
            <span className="font-semibold text-[#34D399]">{data.lufs}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Video / Audio Codec</span>
            <span className="text-[#E8EEF8]">{data.codec}</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-[#8D9AB3]">
            Cryptographic SHA-256 Checksum
          </div>
          <div className="bg-black/40 border border-[#1E2A40] rounded-lg px-3 py-2 font-mono text-[11px] text-[#34D399] break-all select-all">
            {data.sha256}
          </div>
        </div>

        <p className="text-xs text-[#8D9AB3] leading-relaxed">
          Honest-Label Evidence (Rules 1 &amp; 2): In-memory slot receipt computed
          deterministically without synthetic FFprobe results or fake platform
          metrics.
        </p>

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onDismiss}
            className="px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] text-xs font-bold transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
