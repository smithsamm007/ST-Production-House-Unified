import React, { useState } from "react";
import { X } from "lucide-react";
import { ConnectionSlotStatus, PlatformConnection } from "../types/models";
import { StatusBadge, StatusTone } from "../components/StatusBadge";

interface ConnectionsScreenProps {
  connections: PlatformConnection[];
  onUpdateSlot: (
    connectionId: string,
    status: ConnectionSlotStatus,
    locator: string
  ) => void;
}

export const ConnectionsScreen: React.FC<ConnectionsScreenProps> = ({
  connections,
  onUpdateSlot,
}) => {
  const [editingSlot, setEditingSlot] = useState<PlatformConnection | null>(
    null
  );
  const [newLocator, setNewLocator] = useState("");
  const [newStatus, setNewStatus] =
    useState<ConnectionSlotStatus>("sandbox_verified");

  const openEditor = (slot: PlatformConnection) => {
    setEditingSlot(slot);
    setNewLocator(slot.locator);
    setNewStatus(slot.status);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSlot) return;
    onUpdateSlot(editingSlot.id, newStatus, newLocator);
    setEditingSlot(null);
  };

  const getTone = (status: ConnectionSlotStatus): StatusTone => {
    if (status === "live_authenticated") return "ok";
    if (status === "sandbox_verified") return "info";
    return "warn";
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Secrets &amp; Social Connection Slots (Rule 16 &amp; 17)
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Every director possesses isolated connection slots. Opaque
          secret-manager locators (<code className="text-[#22D3EE]">vault://...</code>) only — no
          plaintext keys or cross-agent borrowing.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {connections.map((slot) => (
          <div
            key={slot.id}
            className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-[#E8EEF8]">
                  {slot.platform} Connection Slot
                </h2>
                <p className="text-xs text-[#22D3EE] mt-0.5 tabular-nums">
                  Director {slot.agentId} · Slot Isolation Enforced
                </p>
              </div>
              <StatusBadge
                label={slot.status.replace(/_/g, " ")}
                tone={getTone(slot.status)}
              />
            </div>

            <div className="bg-[#101A2B] border border-[#1E2A40] rounded-lg px-3 py-2 space-y-0.5">
              <div className="text-[11px] font-semibold text-[#8D9AB3]">
                Opaque Locator
              </div>
              <div
                className={`text-xs font-mono break-all ${
                  slot.status === "unconfigured"
                    ? "text-[#8D9AB3]"
                    : "text-[#34D399]"
                }`}
              >
                {slot.locator}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-[11px] text-[#8D9AB3] tabular-nums">
                Last verified: {slot.lastVerified}
              </span>
              <button
                type="button"
                onClick={() => openEditor(slot)}
                className="px-3 py-1.5 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#E8EEF8] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                Configure Slot
              </button>
            </div>
          </div>
        ))}
      </div>

      {editingSlot && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="configure-slot-title"
          onClick={() => setEditingSlot(null)}
        >
          <form
            onSubmit={handleSave}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-[#0D1420] border border-[#2C3D5E] rounded-2xl p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2
                id="configure-slot-title"
                className="text-base font-bold font-display text-[#E8EEF8]"
              >
                Configure {editingSlot.platform} Slot for {editingSlot.agentId}
              </h2>
              <button
                type="button"
                onClick={() => setEditingSlot(null)}
                className="p-1 rounded-lg text-[#8D9AB3] hover:text-[#E8EEF8] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[#8D9AB3] leading-relaxed">
              Rule 4: Provider secrets belong in an external secret manager.
              Enter an opaque secret locator (e.g.{" "}
              <code className="text-[#22D3EE]">
                vault://stph-secrets/{editingSlot.agentId}/
                {editingSlot.platform.toLowerCase()}-token
              </code>
              ).
            </p>

            <div>
              <label className="block text-xs text-[#8D9AB3] mb-1">
                Vault Locator URL
              </label>
              <input
                type="text"
                value={newLocator}
                onChange={(e) => setNewLocator(e.target.value)}
                className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-xs font-mono text-[#E8EEF8] outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <div className="text-xs text-[#8D9AB3]">Status Selection</div>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { id: "sandbox_verified", label: "Sandbox" },
                    { id: "live_authenticated", label: "Live Auth" },
                    { id: "unconfigured", label: "Unconfigured" },
                  ] as { id: ConnectionSlotStatus; label: string }[]
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setNewStatus(opt.id)}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer ${
                      newStatus === opt.id
                        ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                        : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3]"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingSlot(null)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-[#8D9AB3] hover:text-[#E8EEF8] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] text-xs font-bold cursor-pointer"
              >
                Save Slot
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
