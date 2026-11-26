import React, { useEffect, useState } from "react";
import type { Agent, DirectorSchedule } from "../types/models";
import type { DataSourceStatus } from "../types/dataState";
import type { ScheduleView } from "../store/liveMappers";
import { StatusBadge, StatusTone } from "../components/StatusBadge";
import { DataSourceNotice, ScreenHeader } from "../components/DataSourceBadge";
import { dayName } from "../utils/crypto";

interface ScheduleScreenProps {
  agents: Agent[];
  schedules: Record<string, DirectorSchedule>;
  scheduleViews: Record<string, ScheduleView>;
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  onSaveSchedule: (schedule: DirectorSchedule) => Promise<void>;
  onPreviewPlan: (agentId: string) => void;
  onRunSchedulerNow: (agentId: string) => Promise<void>;
  feedbackMessage: string | null;
  onClearFeedback: () => void;
  status: DataSourceStatus;
  onRefresh: () => void;
  busy: boolean;
}

const EMPTY_SCHEDULE = (agentId: string): DirectorSchedule => ({
  agentId,
  mainEpisodeDuration: 1800,
  episodesPerDay: 2,
  productionDays: [1, 2, 3, 4, 5],
  preferredStartTime: "09:00",
  timezone: "Asia/Kolkata",
  enabled: false,
});

const DURATION_OPTIONS = [
  { sec: 1800, label: "30 minutes" },
  { sec: 2400, label: "40 minutes" },
  { sec: 3000, label: "50 minutes" },
];

/**
 * Per-Director schedule backed by /api/scheduling (sql/029).
 *
 * Reads come from the persisted row; the form only prefills from real data and
 * saves through the CSRF-protected PUT. No scheduler tick is simulated.
 */
export const ScheduleScreen: React.FC<ScheduleScreenProps> = ({
  agents,
  schedules,
  scheduleViews,
  selectedAgentId,
  onSelectAgent,
  onSaveSchedule,
  onPreviewPlan,
  onRunSchedulerNow,
  feedbackMessage,
  onClearFeedback,
  status,
  onRefresh,
  busy,
}) => {
  const view = scheduleViews[selectedAgentId];
  const current = schedules[selectedAgentId] ?? EMPTY_SCHEDULE(selectedAgentId);

  const [duration, setDuration] = useState(current.mainEpisodeDuration);
  const [epsPerDay, setEpsPerDay] = useState(current.episodesPerDay);
  const [days, setDays] = useState<number[]>(current.productionDays);
  const [startTime, setStartTime] = useState(current.preferredStartTime);
  const [timezone, setTimezone] = useState(current.timezone);
  const [enabled, setEnabled] = useState(current.enabled);

  useEffect(() => {
    setDuration(current.mainEpisodeDuration || 1800);
    setEpsPerDay(current.episodesPerDay || 2);
    setDays(current.productionDays);
    setStartTime(current.preferredStartTime || "09:00");
    setTimezone(current.timezone || "Asia/Kolkata");
    setEnabled(current.enabled);
  }, [
    selectedAgentId,
    current.mainEpisodeDuration,
    current.episodesPerDay,
    current.productionDays,
    current.preferredStartTime,
    current.timezone,
    current.enabled,
  ]);

  const connected = status.state === "live" || status.state === "stale";
  const configured = view?.configured === true;

  const toggleDay = (day: number) => {
    setDays((previous) =>
      previous.includes(day) ? previous.filter((item) => item !== day) : [...previous, day].sort()
    );
  };

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault();
    void onSaveSchedule({
      agentId: selectedAgentId,
      mainEpisodeDuration: duration,
      episodesPerDay: epsPerDay,
      productionDays: days,
      preferredStartTime: startTime,
      timezone,
      enabled,
    });
  };

  const validity: { tone: StatusTone; label: string } = !configured
    ? { tone: "warn", label: "No persisted schedule" }
    : view?.schedule.mainEpisodeDuration
    ? { tone: "ok", label: "Persisted & valid" }
    : { tone: "bad", label: "Persisted but invalid" };

  return (
    <div className="space-y-5">
      <ScreenHeader
        title="Episode & Production Schedule"
        subtitle="Each Director owns its persisted schedule row (sql/029). Saves are CSRF-protected Owner mutations; scheduler runs queue real work or refuse honestly."
        status={status}
        onRefresh={onRefresh}
        busy={busy}
      />

      <div className="space-y-2">
        <div className="text-xs font-semibold text-[#8D9AB3]">Select Director</div>
        {agents.length === 0 ? (
          <p className="text-xs text-[#8D9AB3]">No Director records were returned.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {agents.slice(0, 24).map((agent) => {
              const selected = agent.id === selectedAgentId;
              const hasSchedule = scheduleViews[agent.id]?.configured === true;
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => onSelectAgent(agent.id)}
                  className={`px-3 py-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                    selected
                      ? "bg-[#4F8CFF]/15 border-[#4F8CFF]"
                      : "bg-[#0D1420] border-[#1E2A40] hover:border-[#2C3D5E]"
                  }`}
                >
                  <div
                    className={`text-xs font-semibold font-mono truncate ${
                      selected ? "text-[#22D3EE]" : "text-[#E8EEF8]"
                    }`}
                  >
                    {agent.id}
                  </div>
                  <div className="text-[11px] text-[#8D9AB3] mt-0.5">
                    {hasSchedule ? "schedule saved" : "no schedule row"}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!connected ? (
        <DataSourceNotice status={status} title="Director schedules" onRetry={onRefresh} />
      ) : (
        <form
          onSubmit={handleSave}
          className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-[#22D3EE] font-display">
              Schedule for {selectedAgentId}
            </h2>
            <div className="flex items-center gap-2">
              <StatusBadge label={validity.label} tone={validity.tone} />
              <StatusBadge
                label={enabled ? "will be enabled" : "paused"}
                tone={enabled ? "ok" : "warn"}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-[#E8EEF8]">Main Episode Duration</div>
            <div className="flex flex-wrap gap-2">
              {DURATION_OPTIONS.map((option) => (
                <button
                  key={option.sec}
                  type="button"
                  onClick={() => setDuration(option.sec)}
                  className={`px-3.5 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    duration === option.sec
                      ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                      : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="eps-per-day" className="font-medium text-[#E8EEF8]">
                Episodes Per Day
              </label>
              <span className="font-mono font-bold text-[#22D3EE] tabular-nums">
                {epsPerDay} / day
              </span>
            </div>
            <input
              id="eps-per-day"
              type="range"
              min={1}
              max={6}
              step={1}
              value={epsPerDay}
              onChange={(event) => setEpsPerDay(Number(event.target.value))}
              className="w-full accent-[#4F8CFF] cursor-pointer"
            />
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-[#E8EEF8]">Production Days</span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setDays([1, 2, 3, 4, 5, 6, 7])}
                  className="text-xs font-medium text-[#22D3EE] hover:underline cursor-pointer"
                >
                  Every day
                </button>
                <button
                  type="button"
                  onClick={() => setDays([1, 2, 3, 4, 5])}
                  className="text-xs font-medium text-[#22D3EE] hover:underline cursor-pointer"
                >
                  Mon–Fri
                </button>
              </div>
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                const active = days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(day)}
                    className={`py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? "bg-[#4F8CFF]/25 border-[#4F8CFF] text-[#22D3EE]"
                        : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
                    }`}
                  >
                    {dayName(day)}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-[#8D9AB3]">
              Selected: {days.sort().map(dayName).join(", ") || "none"}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="sched-start-time" className="block text-xs text-[#8D9AB3] mb-1">
                Preferred Start Time
              </label>
              <input
                id="sched-start-time"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                required
                className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm font-mono text-[#E8EEF8] outline-none"
              />
            </div>
            <div>
              <label htmlFor="sched-timezone" className="block text-xs text-[#8D9AB3] mb-1">
                Timezone (IANA)
              </label>
              <input
                id="sched-timezone"
                type="text"
                list="sched-tz-options"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                required
                className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm font-mono text-[#E8EEF8] outline-none"
              />
              <datalist id="sched-tz-options">
                <option value="Asia/Kolkata" />
                <option value="Asia/Dubai" />
                <option value="Europe/London" />
                <option value="America/New_York" />
                <option value="America/Los_Angeles" />
                <option value="UTC" />
              </datalist>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 py-2 border-t border-b border-[#1E2A40]">
            <div>
              <div className="text-sm font-medium text-[#E8EEF8]">Schedule Enabled</div>
              <div className="text-xs text-[#8D9AB3]">
                Enabling is a standing production commitment; retirement rules apply server-side.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Schedule enabled"
              onClick={() => setEnabled((value) => !value)}
              className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer ${
                enabled ? "bg-[#4F8CFF]" : "bg-[#1E2A40]"
              }`}
            >
              <span
                className={`block w-4 h-4 rounded-full bg-white transition-transform ${
                  enabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          <div className="space-y-2.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 px-4 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] disabled:opacity-60 text-[#070B12] text-xs font-bold transition-colors cursor-pointer"
              >
                {busy ? "Saving…" : "Save Schedule"}
              </button>
              <button
                type="button"
                onClick={() => onPreviewPlan(selectedAgentId)}
                className="w-full py-2.5 px-4 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-semibold text-[#E8EEF8] transition-colors cursor-pointer"
              >
                Preview Persisted Plan
              </button>
            </div>

            <button
              type="button"
              disabled={busy || !configured}
              onClick={() => void onRunSchedulerNow(selectedAgentId)}
              className="w-full py-2.5 px-4 rounded-lg border border-[#34D399]/50 hover:bg-[#34D399]/10 disabled:opacity-40 disabled:hover:bg-transparent text-xs font-semibold text-[#34D399] transition-colors cursor-pointer"
            >
              {configured
                ? "Run Scheduler Now (POST /api/scheduling/directors/:id/run)"
                : "Save a schedule before running the scheduler"}
            </button>
          </div>
        </form>
      )}

      {feedbackMessage && (
        <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-[#22D3EE]">Scheduler Result</span>
            <button
              type="button"
              onClick={onClearFeedback}
              className="text-xs text-[#8D9AB3] hover:text-[#E8EEF8] cursor-pointer"
            >
              Dismiss
            </button>
          </div>
          <p className="text-xs text-[#E8EEF8] leading-relaxed whitespace-pre-wrap">
            {feedbackMessage}
          </p>
        </div>
      )}
    </div>
  );
};
