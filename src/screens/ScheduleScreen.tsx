import React, { useEffect, useState } from "react";
import { Channel, DirectorSchedule } from "../types/models";
import { DirectorChannelTabs } from "../components/StatusBadge";
import { dayName } from "../utils/crypto";

interface ScheduleScreenProps {
  channels: Channel[];
  schedules: Record<string, DirectorSchedule>;
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  onSaveSchedule: (schedule: DirectorSchedule) => void;
  onPreviewPlan: (agentId: string) => void;
  onRunSchedulerNow: (agentId: string) => void;
  feedbackMessage: string | null;
  onClearFeedback: () => void;
}

const DEFAULT_SCHEDULE = (agentId: string): DirectorSchedule => ({
  agentId,
  mainEpisodeDuration: 1800,
  episodesPerDay: 2,
  productionDays: [1, 2, 3, 4, 5],
  preferredStartTime: "09:00",
  timezone: "Asia/Kolkata",
  enabled: true,
});

export const ScheduleScreen: React.FC<ScheduleScreenProps> = ({
  channels,
  schedules,
  selectedAgentId,
  onSelectAgent,
  onSaveSchedule,
  onPreviewPlan,
  onRunSchedulerNow,
  feedbackMessage,
  onClearFeedback,
}) => {
  const currentSchedule =
    schedules[selectedAgentId] ?? DEFAULT_SCHEDULE(selectedAgentId);

  const [duration, setDuration] = useState(currentSchedule.mainEpisodeDuration);
  const [epsPerDay, setEpsPerDay] = useState(currentSchedule.episodesPerDay);
  const [days, setDays] = useState<number[]>(currentSchedule.productionDays);
  const [startTime, setStartTime] = useState(
    currentSchedule.preferredStartTime
  );
  const [timezone, setTimezone] = useState(currentSchedule.timezone);
  const [enabled, setEnabled] = useState(currentSchedule.enabled);

  useEffect(() => {
    const next = schedules[selectedAgentId] ?? DEFAULT_SCHEDULE(selectedAgentId);
    setDuration(next.mainEpisodeDuration);
    setEpsPerDay(next.episodesPerDay);
    setDays(next.productionDays);
    setStartTime(next.preferredStartTime);
    setTimezone(next.timezone);
    setEnabled(next.enabled);
  }, [selectedAgentId, schedules]);

  const toggleDay = (d: number) => {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((item) => item !== d) : [...prev, d]
    );
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveSchedule({
      agentId: selectedAgentId,
      mainEpisodeDuration: duration,
      episodesPerDay: epsPerDay,
      productionDays: days,
      preferredStartTime: startTime,
      timezone,
      enabled,
    });
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Episode &amp; Production Schedule (sql/029)
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Each director owns its settings: duration, episodes per day,
          production days, start time, and timezone. Scheduler runs queue
          planned episodes into the approval pipeline.
        </p>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold text-[#8D9AB3]">
          Select Director Channel
        </div>
        <DirectorChannelTabs
          channels={channels}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
        />
      </div>

      <form
        onSubmit={handleSave}
        className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-5 space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-[#22D3EE] font-display">
            Schedule Configuration for {selectedAgentId}
          </h2>
          <span className="text-xs text-[#8D9AB3] tabular-nums">
            {enabled ? "Active schedule" : "Paused"}
          </span>
        </div>

        {/* Episode Duration */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-[#E8EEF8]">
            Main Episode Duration
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { sec: 1800, label: "30 minutes" },
              { sec: 2400, label: "40 minutes" },
              { sec: 3000, label: "50 minutes" },
            ].map((opt) => {
              const selected = duration === opt.sec;
              return (
                <button
                  key={opt.sec}
                  type="button"
                  onClick={() => setDuration(opt.sec)}
                  className={`px-3.5 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    selected
                      ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                      : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Episodes Per Day */}
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
            onChange={(e) => setEpsPerDay(Number(e.target.value))}
            className="w-full accent-[#4F8CFF] cursor-pointer"
          />
          <div className="flex justify-between text-[11px] font-mono text-[#8D9AB3] tabular-nums">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        </div>

        {/* Production Days */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-[#E8EEF8]">
              Production Days
            </span>
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
            {[1, 2, 3, 4, 5, 6, 7].map((d) => {
              const active = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(d)}
                  className={`py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                    active
                      ? "bg-[#4F8CFF]/25 border-[#4F8CFF] text-[#22D3EE]"
                      : "bg-[#101A2B] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
                  }`}
                >
                  {dayName(d)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Time & Timezone */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="sched-start-time"
              className="block text-xs text-[#8D9AB3] mb-1"
            >
              Preferred Start Time
            </label>
            <input
              id="sched-start-time"
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              required
              className="w-full bg-[#101A2B] border border-[#1E2A40] focus:border-[#4F8CFF] rounded-lg px-3 py-2 text-sm font-mono text-[#E8EEF8] outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="sched-timezone"
              className="block text-xs text-[#8D9AB3] mb-1"
            >
              Timezone (IANA)
            </label>
            <input
              id="sched-timezone"
              type="text"
              list="sched-tz-options"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
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

        {/* Enabled Toggle */}
        <div className="flex items-center justify-between gap-4 py-2 border-t border-b border-[#1E2A40]">
          <div>
            <div className="text-sm font-medium text-[#E8EEF8]">
              Schedule Enabled
            </div>
            <div className="text-xs text-[#8D9AB3]">
              Unchecked = Paused production
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((v) => !v)}
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

        {/* Action Buttons */}
        <div className="space-y-2.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="submit"
              className="w-full py-2.5 px-4 rounded-lg bg-[#4F8CFF] hover:bg-[#3B7DF8] text-[#070B12] text-xs font-bold transition-colors cursor-pointer"
            >
              Save Schedule
            </button>
            <button
              type="button"
              onClick={() => onPreviewPlan(selectedAgentId)}
              className="w-full py-2.5 px-4 rounded-lg border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-semibold text-[#E8EEF8] transition-colors cursor-pointer"
            >
              Preview Plan
            </button>
          </div>

          <button
            type="button"
            onClick={() => onRunSchedulerNow(selectedAgentId)}
            className="w-full py-2.5 px-4 rounded-lg border border-[#34D399]/50 hover:bg-[#34D399]/10 text-xs font-semibold text-[#34D399] transition-colors cursor-pointer"
          >
            Run Scheduler Now (Queues Due Slot)
          </button>
        </div>
      </form>

      {feedbackMessage && (
        <div className="bg-[#101A2B] border border-[#2C3D5E] rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-[#22D3EE]">
              Scheduler Execution Result
            </span>
            <button
              type="button"
              onClick={onClearFeedback}
              className="text-xs text-[#8D9AB3] hover:text-[#E8EEF8] cursor-pointer"
            >
              Dismiss
            </button>
          </div>
          <p className="text-xs text-[#E8EEF8] leading-relaxed">
            {feedbackMessage}
          </p>
        </div>
      )}
    </div>
  );
};
