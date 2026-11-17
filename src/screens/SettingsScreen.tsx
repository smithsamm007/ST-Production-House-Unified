import React, { useState } from "react";
import { Owner, PublishingMode } from "../types/models";
import { StatusBadge } from "../components/StatusBadge";

interface SettingsScreenProps {
  owner: Owner;
  storageMode: string;
  storageStatus: string;
  defaultPublishingMode: PublishingMode;
  onPublishingModeChange: (mode: PublishingMode) => void;
  onLogout: () => void;
  onResetToCanonical: () => void;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({
  owner,
  storageMode,
  storageStatus,
  defaultPublishingMode,
  onPublishingModeChange,
  onLogout,
  onResetToCanonical,
}) => {
  const [showResetDialog, setShowResetDialog] = useState(false);

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Settings &amp; System Configuration
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Control plane configuration, storage runtime, publishing safety
          defaults, and owner profile.
        </p>
      </div>

      {/* Owner Identity */}
      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3.5">
        <h2 className="text-sm font-bold font-display text-[#22D3EE]">
          Owner Identity
        </h2>
        <div className="space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Email</span>
            <span className="font-semibold text-[#E8EEF8]">{owner.email}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Role</span>
            <StatusBadge label={owner.role} tone="ok" />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Session</span>
            <StatusBadge
              label={
                owner.isAuthenticated ? "Active (CSRF protected)" : "Expired"
              }
              tone="ok"
            />
          </div>
        </div>
        <div className="pt-2">
          <button
            type="button"
            onClick={onLogout}
            className="w-full py-2.5 px-4 rounded-lg bg-[#F87171]/15 hover:bg-[#F87171]/25 border border-[#F87171]/35 text-[#F87171] text-xs font-bold transition-colors cursor-pointer"
          >
            Sign Out of Owner Console
          </button>
        </div>
      </section>

      {/* Storage & Database Engine */}
      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3.5">
        <h2 className="text-sm font-bold font-display text-[#22D3EE]">
          Storage &amp; Database Engine
        </h2>
        <div className="space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Runtime Mode</span>
            <StatusBadge label={`${storageMode} mode`} tone="info" />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[#8D9AB3]">Health Check</span>
            <StatusBadge label={storageStatus} tone="ok" />
          </div>
        </div>
        <p className="text-xs text-[#8D9AB3] leading-relaxed">
          Honest-Label Contract (AGENTS.md Rules 1–3): All operations are
          verifiable. No fake provider receipts or synthetic URLs are ever
          generated.
        </p>
        <button
          type="button"
          onClick={() => setShowResetDialog(true)}
          className="w-full py-2.5 px-4 rounded-lg border border-[#FBBF24]/50 hover:bg-[#FBBF24]/10 text-[#FBBF24] text-xs font-semibold transition-colors cursor-pointer"
        >
          Reset System to Canonical Seed Data
        </button>
      </section>

      {/* Publishing Safety Policy */}
      <section className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold font-display text-[#22D3EE]">
          Publishing Safety Policy (Rule 7)
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-[#E8EEF8]">
              Default Mode
            </div>
            <div className="text-xs text-[#8D9AB3]">
              Safe dry run prevents accidental social dispatch
            </div>
          </div>

          <div className="flex items-center gap-2">
            {(
              [
                { id: "dry_run", label: "Dry Run" },
                { id: "live", label: "Live" },
              ] as { id: PublishingMode; label: string }[]
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onPublishingModeChange(opt.id)}
                className={`px-3.5 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                  defaultPublishingMode === opt.id
                    ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                    : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {showResetDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-dialog-title"
          onClick={() => setShowResetDialog(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-[#0D1420] border border-[#2C3D5E] rounded-2xl p-6 shadow-2xl space-y-4"
          >
            <h2
              id="reset-dialog-title"
              className="text-base font-bold font-display text-[#E8EEF8]"
            >
              Confirm Reset to Canonical
            </h2>
            <p className="text-xs text-[#8D9AB3] leading-relaxed">
              This will restore the 4 canonical channels, schedules, charters,
              initial jobs, and initial evidence ledger to default seed values.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowResetDialog(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-[#8D9AB3] hover:text-[#E8EEF8] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onResetToCanonical();
                  setShowResetDialog(false);
                }}
                className="px-4 py-2 rounded-lg bg-[#FBBF24] hover:bg-[#EAB308] text-[#070B12] text-xs font-bold cursor-pointer"
              >
                Confirm Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
