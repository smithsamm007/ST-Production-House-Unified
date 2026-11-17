import React, { useMemo } from "react";
import { ProductionJob } from "../types/models";
import { StatusBadge, StatusTone } from "../components/StatusBadge";

interface JobsScreenProps {
  jobs: ProductionJob[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  onPauseJob: (jobId: string) => void;
  onResumeJob: (jobId: string) => void;
  onCancelJob: (jobId: string) => void;
}

const JOB_FILTERS = [
  "ALL",
  "RUNNING",
  "QUEUED",
  "PAUSED",
  "WAITING_FOR_QUOTA",
  "WAITING_FOR_APPROVAL",
  "SUCCEEDED",
  "FAILED",
];

export const JobsScreen: React.FC<JobsScreenProps> = ({
  jobs,
  currentFilter,
  onFilterChange,
  onPauseJob,
  onResumeJob,
  onCancelJob,
}) => {
  const filteredJobs = useMemo(() => {
    if (currentFilter === "ALL") return jobs;
    return jobs.filter(
      (j) => j.status.toUpperCase() === currentFilter.toUpperCase()
    );
  }, [jobs, currentFilter]);

  const getTone = (status: string): StatusTone => {
    if (status === "running" || status === "waiting_for_quota") return "warn";
    if (status === "succeeded") return "ok";
    if (status === "failed") return "bad";
    return "info";
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold font-display text-[#E8EEF8]">
          Active Production Jobs
        </h1>
        <p className="text-xs text-[#8D9AB3] mt-0.5">
          Job lifecycle &amp; checkpoint control (sql/010 + sql/017). Queue
          workers execute with durable leases, retry recovery, and quota limits.
        </p>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap gap-1.5">
        {JOB_FILTERS.map((filter) => {
          const active = currentFilter === filter;
          return (
            <button
              key={filter}
              type="button"
              onClick={() => onFilterChange(filter)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                active
                  ? "bg-[#4F8CFF]/20 border-[#4F8CFF] text-[#22D3EE]"
                  : "bg-[#0D1420] border-[#1E2A40] text-[#8D9AB3] hover:text-[#E8EEF8]"
              }`}
            >
              {filter.replace(/_/g, " ")}
            </button>
          );
        })}
      </div>

      {filteredJobs.length === 0 ? (
        <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-10 text-center space-y-3">
          <p className="text-sm text-[#8D9AB3]">
            No jobs matching status filter “{currentFilter.replace(/_/g, " ")}”.
          </p>
          <button
            type="button"
            onClick={() => onFilterChange("ALL")}
            className="px-3.5 py-1.5 rounded-lg border border-[#2C3D5E] text-xs font-medium text-[#22D3EE] hover:bg-[#101A2B] cursor-pointer"
          >
            Show all jobs
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredJobs.map((job) => (
            <div
              key={job.id}
              className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-4 space-y-3 flex flex-col justify-between"
            >
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-bold text-[#E8EEF8] tracking-wide">
                      {job.capability.replace(/_/g, " ").toUpperCase()}
                    </h2>
                    <p className="text-xs text-[#22D3EE] mt-0.5 tabular-nums">
                      Director {job.agentId} · {job.createdAt}
                    </p>
                  </div>
                  <StatusBadge
                    label={job.status.replace(/_/g, " ")}
                    tone={getTone(job.status)}
                  />
                </div>

                <p className="text-xs text-[#8D9AB3]">{job.note}</p>

                {(job.status === "running" ||
                  job.status === "waiting_for_quota") && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] font-mono text-[#8D9AB3] tabular-nums">
                      <span>Progress</span>
                      <span>{job.progressPercent}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-[#1E2A40] overflow-hidden">
                      <div
                        className="h-full bg-[#4F8CFF] rounded-full"
                        style={{ width: `${job.progressPercent}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#1E2A40]">
                <span className="text-[11px] font-mono text-[#8D9AB3] tabular-nums">
                  ID: {job.id.slice(0, 8)}
                </span>

                <div className="flex items-center gap-2">
                  {job.status === "running" && (
                    <button
                      type="button"
                      onClick={() => onPauseJob(job.id)}
                      className="px-2.5 py-1 rounded-md border border-[#2C3D5E] hover:border-[#4F8CFF] text-xs font-medium text-[#E8EEF8] cursor-pointer"
                    >
                      Pause
                    </button>
                  )}
                  {job.status === "paused" && (
                    <button
                      type="button"
                      onClick={() => onResumeJob(job.id)}
                      className="px-2.5 py-1 rounded-md border border-[#34D399]/50 hover:bg-[#34D399]/10 text-xs font-medium text-[#34D399] cursor-pointer"
                    >
                      Resume
                    </button>
                  )}
                  {(job.status === "running" ||
                    job.status === "queued" ||
                    job.status === "waiting_for_quota") && (
                    <button
                      type="button"
                      onClick={() => onCancelJob(job.id)}
                      className="px-2.5 py-1 rounded-md border border-[#F87171]/50 hover:bg-[#F87171]/10 text-xs font-medium text-[#F87171] cursor-pointer"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
