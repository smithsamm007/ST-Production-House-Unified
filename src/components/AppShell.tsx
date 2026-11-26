import React, { useState } from "react";
import {
  Activity,
  Bell,
  Bot,
  Boxes,
  CalendarClock,
  CheckCircle2,
  Database,
  Film,
  KeyRound,
  Layers,
  LayoutGrid,
  Link2,
  LogOut,
  Menu,
  MessageSquare,
  PlaySquare,
  Settings,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import {
  CORE_BOTTOM_TABS,
  NAV_ITEMS,
  Owner,
  OwnerAvailability,
  ScreenSection,
} from "../types/models";
import { StatusBadge } from "./StatusBadge";

interface AppShellProps {
  owner: Owner;
  currentSection: ScreenSection;
  onNavigate: (section: ScreenSection) => void;
  onLogout: () => void;
  storageMode: string;
  storageStatus: string;
  agentCount: number;
  channelCount: number;
  pendingApprovalsCount: number;
  ownerAvailability: OwnerAvailability | "unknown";
  children: React.ReactNode;
}

const SECTION_ICONS: Record<ScreenSection, React.ReactNode> = {
  overview: <LayoutGrid className="w-4 h-4" />,
  directors: <Users className="w-4 h-4" />,
  schedule: <CalendarClock className="w-4 h-4" />,
  communication: <MessageSquare className="w-4 h-4" />,
  memory: <Database className="w-4 h-4" />,
  production: <PlaySquare className="w-4 h-4" />,
  jobs: <Activity className="w-4 h-4" />,
  providers: <Film className="w-4 h-4" />,
  connections: <KeyRound className="w-4 h-4" />,
  approvals: <CheckCircle2 className="w-4 h-4" />,
  notifications: <Bell className="w-4 h-4" />,
  fleet: <Boxes className="w-4 h-4" />,
  evidence: <Link2 className="w-4 h-4" />,
  hermes: <Bot className="w-4 h-4" />,
  architecture: <Layers className="w-4 h-4" />,
  settings: <Settings className="w-4 h-4" />,
};

export const AppShell: React.FC<AppShellProps> = ({
  owner,
  currentSection,
  onNavigate,
  onLogout,
  storageMode,
  storageStatus,
  agentCount,
  channelCount,
  pendingApprovalsCount,
  ownerAvailability,
  children,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const activeNav = NAV_ITEMS.find((n) => n.id === currentSection);

  const handleSelectSection = (section: ScreenSection) => {
    onNavigate(section);
    setMobileMenuOpen(false);
  };

  const SidebarContent = (
    <div className="flex flex-col h-full justify-between py-4 px-3">
      <div className="space-y-1">
        <div className="px-2.5 pb-2 text-[11px] font-semibold text-[#8D9AB3] tracking-wider uppercase">
          Owner Console
        </div>
        {NAV_ITEMS.map((item) => {
          const isSelected = currentSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelectSection(item.id)}
              className={`w-full flex items-center justify-between gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4F8CFF] ${
                isSelected
                  ? "bg-[#4F8CFF]/15 text-[#22D3EE] font-semibold"
                  : "text-[#E8EEF8] hover:bg-[#101A2B]"
              }`}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <span
                  className={isSelected ? "text-[#22D3EE]" : "text-[#8D9AB3]"}
                >
                  {SECTION_ICONS[item.id]}
                </span>
                <span className="truncate">{item.title}</span>
              </span>
              {item.id === "approvals" && pendingApprovalsCount > 0 && (
                <span className="text-[11px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-[#FBBF24]/15 text-[#FBBF24] border border-[#FBBF24]/30">
                  {pendingApprovalsCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Hermes AI Manager Mini Summary Card */}
      <div className="mt-6 bg-[#101A2B] border border-[#1E2A40] rounded-xl p-3.5 space-y-2">
        <div className="text-xs font-bold text-[#22D3EE] font-display">
          Hermes AI Manager
        </div>
        <div className="space-y-1 text-xs">
          <div className="flex justify-between text-[#8D9AB3]">
            <span>Registered directors</span>
            <span className="text-[#E8EEF8] font-mono tabular-nums font-semibold">
              {agentCount}/50
            </span>
          </div>
          <div className="flex justify-between text-[#8D9AB3]">
            <span>Live channels</span>
            <span className="text-[#E8EEF8] font-mono tabular-nums font-semibold">
              {channelCount}
            </span>
          </div>
          <div className="flex justify-between text-[#8D9AB3]">
            <span>Central platform</span>
            <span className="text-[#E8EEF8] font-mono tabular-nums font-semibold">
              1
            </span>
          </div>
          <div className="flex justify-between text-[#8D9AB3]">
            <span>Owner status</span>
            <span
              className={`font-mono font-semibold ${
                ownerAvailability === "available"
                  ? "text-[#34D399]"
                  : ownerAvailability === "unknown"
                  ? "text-[#8D9AB3]"
                  : "text-[#FBBF24]"
              }`}
            >
              {ownerAvailability}
            </span>
          </div>
          <div className="flex justify-between text-[#8D9AB3]">
            <span>Storage</span>
            <span className="text-[#34D399] font-mono font-semibold">
              {storageMode} ({storageStatus})
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#070B12] text-[#E8EEF8]">
      {/* Top Bar — clean 3-zone header */}
      <header className="sticky top-0 z-30 bg-[#0D1420]/95 backdrop-blur-sm border-b border-[#1E2A40]">
        <div className="flex items-center justify-between gap-4 px-4 lg:px-6 h-14">
          {/* Zone 1: Brand + Mobile Menu Trigger */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 rounded-lg border border-[#1E2A40] text-[#22D3EE] hover:bg-[#101A2B] cursor-pointer"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-[#101A2B] border border-[#2C3D5E] flex items-center justify-center font-display font-extrabold text-xs tracking-wider text-[#22D3EE]">
                ST
              </div>
              <span className="font-display font-bold text-sm tracking-wider text-[#E8EEF8] whitespace-nowrap">
                ST PRODUCTION HOUSE
              </span>
            </div>
          </div>

          {/* Zone 2: Section Context */}
          <div className="hidden md:flex items-center gap-2 text-xs text-[#8D9AB3] truncate">
            <span>Owner Console</span>
            <span aria-hidden="true">/</span>
            <span className="text-[#E8EEF8] font-medium whitespace-nowrap">
              {activeNav?.title ?? "Command Center"}
            </span>
          </div>

          {/* Zone 3: Storage status, owner email, Sign out */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden sm:block">
              <StatusBadge
                label={`${storageMode} · ${storageStatus}`}
                tone="ok"
              />
            </div>
            <span className="hidden md:inline text-xs text-[#8D9AB3] truncate max-w-[180px]">
              {owner.email}
            </span>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#2C3D5E] hover:border-[#F87171]/60 text-xs font-medium text-[#E8EEF8] hover:text-[#F87171] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          </div>
        </div>

        {/* Data-source contract banner (Day 2) */}
        <div className="bg-[#22D3EE]/10 border-t border-[#22D3EE]/30 px-4 lg:px-6 py-1.5 flex items-center gap-2 text-xs text-[#22D3EE]">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium truncate">
            AUTHENTICATED CONTROL PLANE — every value comes from the PostgreSQL-backed
            API. Each screen carries a LIVE / STALE / UNAVAILABLE badge; a missing
            capability is labelled, never simulated.
          </span>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="flex-1 flex min-h-0">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:block w-64 shrink-0 bg-[#0D1420]/70 border-r border-[#1E2A40] overflow-y-auto">
          {SidebarContent}
        </aside>

        {/* Mobile Drawer Overlay */}
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 z-50 lg:hidden flex"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation drawer"
          >
            <div
              className="fixed inset-0 bg-black/70"
              onClick={() => setMobileMenuOpen(false)}
            />
            <aside className="relative w-72 max-w-[85vw] bg-[#0D1420] border-r border-[#1E2A40] h-full overflow-y-auto z-10">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[#1E2A40]">
                <span className="font-display font-bold text-sm text-[#22D3EE]">
                  OWNER CONSOLE
                </span>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="Close navigation menu"
                  className="p-1.5 rounded-lg text-[#8D9AB3] hover:text-[#E8EEF8]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {SidebarContent}
            </aside>
          </div>
        )}

        {/* Active Screen Viewport */}
        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 pb-24 lg:pb-8 max-w-[1440px]">
          {currentSection !== "overview" && (
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="text-xs text-[#8D9AB3]">
                Multiple Directors · Independent Universes · One Production House
              </div>
              <button
                type="button"
                onClick={() => onNavigate("overview")}
                className="text-xs font-medium text-[#22D3EE] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                ← Back to Command Center
              </button>
            </div>
          )}
          {children}
        </main>
      </div>

      {/* Mobile Quick Bottom Navigation (Core 5 Workflows) */}
      <nav
        aria-label="Quick workflow navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-[#0D1420]/95 backdrop-blur-sm border-t border-[#1E2A40] grid grid-cols-5"
      >
        {CORE_BOTTOM_TABS.map((tabId) => {
          const item = NAV_ITEMS.find((n) => n.id === tabId)!;
          const isSelected = currentSection === tabId;
          return (
            <button
              key={tabId}
              type="button"
              onClick={() => onNavigate(tabId)}
              className={`flex flex-col items-center justify-center py-2 px-1 gap-1 text-[11px] transition-colors cursor-pointer ${
                isSelected ? "text-[#22D3EE] font-semibold" : "text-[#8D9AB3]"
              }`}
            >
              {SECTION_ICONS[tabId]}
              <span className="truncate max-w-full">
                {item.shortLabel ?? item.title}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
