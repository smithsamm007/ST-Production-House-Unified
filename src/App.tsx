import React, { Suspense, lazy } from "react";
import { useProductionStore } from "./store/useProductionStore";
import { AppShell } from "./components/AppShell";
import { InspectionModal } from "./components/InspectionModal";
import { LoginScreen } from "./screens/LoginScreen";

/**
 * Route-level code splitting (main's architecture, preserved).
 *
 * The login screen and the shell stay in the initial chunk so authentication
 * and navigation are immediately responsive; every console screen is loaded on
 * first navigation. Named exports are adapted to the `default` shape React.lazy
 * requires, and no new dependency is introduced.
 *
 * The wiring below is the Day 2 authenticated contract: each screen receives a
 * `DataSourceStatus` (LIVE / STALE / OFFLINE / UNAVAILABLE …) plus explicit
 * refresh callbacks, so a rendered screen can never imply a connection it does
 * not have. The old demo-store props (`onApprove`, `releases`, `jobs`) are gone.
 */
const OverviewScreen = lazy(() =>
  import("./screens/OverviewScreen").then((m) => ({ default: m.OverviewScreen }))
);
const DirectorsScreen = lazy(() =>
  import("./screens/DirectorsScreen").then((m) => ({ default: m.DirectorsScreen }))
);
const ScheduleScreen = lazy(() =>
  import("./screens/ScheduleScreen").then((m) => ({ default: m.ScheduleScreen }))
);
const CommunicationScreen = lazy(() =>
  import("./screens/CommunicationScreen").then((m) => ({
    default: m.CommunicationScreen,
  }))
);
const MemoryScreen = lazy(() =>
  import("./screens/MemoryScreen").then((m) => ({ default: m.MemoryScreen }))
);
const ProductionScreen = lazy(() =>
  import("./screens/ProductionScreen").then((m) => ({
    default: m.ProductionScreen,
  }))
);
const JobsScreen = lazy(() =>
  import("./screens/JobsScreen").then((m) => ({ default: m.JobsScreen }))
);
const ProvidersQuotasScreen = lazy(() =>
  import("./screens/ProvidersQuotasScreen").then((m) => ({
    default: m.ProvidersQuotasScreen,
  }))
);
const ConnectionsScreen = lazy(() =>
  import("./screens/ConnectionsScreen").then((m) => ({
    default: m.ConnectionsScreen,
  }))
);
const ApprovalsScreen = lazy(() =>
  import("./screens/ApprovalsScreen").then((m) => ({
    default: m.ApprovalsScreen,
  }))
);
const NotificationsScreen = lazy(() =>
  import("./screens/NotificationsScreen").then((m) => ({
    default: m.NotificationsScreen,
  }))
);
const FleetScreen = lazy(() =>
  import("./screens/FleetScreen").then((m) => ({ default: m.FleetScreen }))
);
const EvidenceScreen = lazy(() =>
  import("./screens/EvidenceScreen").then((m) => ({ default: m.EvidenceScreen }))
);
const HermesScreen = lazy(() =>
  import("./screens/HermesScreen").then((m) => ({ default: m.HermesScreen }))
);
const ArchitectureScreen = lazy(() =>
  import("./screens/ArchitectureScreen").then((m) => ({
    default: m.ArchitectureScreen,
  }))
);
const SettingsScreen = lazy(() =>
  import("./screens/SettingsScreen").then((m) => ({ default: m.SettingsScreen }))
);

/** Accessible fallback while a screen chunk loads. */
const ScreenFallback: React.FC = () => (
  <div
    role="status"
    aria-live="polite"
    className="min-h-[40vh] flex flex-col items-center justify-center gap-2"
  >
    <div className="w-6 h-6 rounded-full border-2 border-[#2C3D5E] border-t-[#22D3EE] animate-spin" />
    <span className="text-xs text-[#8D9AB3]">Loading console module…</span>
  </div>
);

const BootScreen: React.FC = () => (
  <div
    role="status"
    aria-live="polite"
    className="min-h-screen flex flex-col items-center justify-center gap-3 bg-[#070B12]"
  >
    <div className="w-8 h-8 rounded-full border-2 border-[#2C3D5E] border-t-[#22D3EE] animate-spin" />
    <div className="text-sm text-[#E8EEF8] font-medium">Verifying Owner session…</div>
    <div className="text-[11px] text-[#8D9AB3]">
      Asking the backend who is signed in. No cached identity is trusted.
    </div>
  </div>
);

export const App: React.FC = () => {
  const store = useProductionStore();

  if (store.sessionStatus === "checking") {
    return <BootScreen />;
  }

  if (!store.currentOwner || store.mfaRequired) {
    return (
      <LoginScreen
        onLogin={store.login}
        onVerifyTotp={store.verifyMfa}
        mfaRequired={store.mfaRequired}
        busy={store.busy}
        sessionError={store.sessionError}
        sessionExpired={store.sessionExpired}
      />
    );
  }

  const pendingApprovalsCount = store.approvals.filter(
    (approval) => approval.status.toUpperCase().includes("PENDING")
  ).length;

  return (
    <>
      <AppShell
        owner={store.currentOwner}
        currentSection={store.currentSection}
        onNavigate={store.navigateTo}
        onLogout={() => void store.logout()}
        storageMode={store.storageMode}
        storageStatus={store.storageStatus}
        agentCount={store.agents.length}
        channelCount={store.channels.length}
        pendingApprovalsCount={pendingApprovalsCount}
        ownerAvailability={store.ownerAvailability}
      >
        {store.actionError && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-[#F87171]/40 bg-[#F87171]/10 px-4 py-2.5 flex items-start justify-between gap-3"
          >
            <span className="text-xs text-[#F87171] leading-relaxed">{store.actionError}</span>
            <button
              type="button"
              onClick={store.dismissActionError}
              className="text-xs text-[#F87171] hover:text-[#E8EEF8] cursor-pointer whitespace-nowrap"
            >
              Dismiss
            </button>
          </div>
        )}

        <Suspense fallback={<ScreenFallback />}>
          {store.currentSection === "overview" && (
            <OverviewScreen
              metrics={store.metrics}
              health={store.health}
              ready={store.ready}
              agents={store.agents}
              channels={store.channels}
              releases={store.releases}
              approvals={store.approvals}
              hermesOverview={store.hermesOverview}
              overviewStatus={store.sources.overview}
              productionStatus={store.sources.production}
              approvalsStatus={store.sources.approvals}
              onNavigate={store.navigateTo}
              onRefresh={store.refreshAll}
              busy={store.busy}
            />
          )}

          {store.currentSection === "directors" && (
            <DirectorsScreen
              agents={store.agents}
              channels={store.channels}
              status={store.sources.directors}
              searchQuery={store.channelSearchQuery}
              onSearchQueryChange={store.setChannelSearchQuery}
              onAddChannel={store.addChannel}
              onRefresh={store.refreshAll}
              busy={store.busy}
            />
          )}

          {store.currentSection === "schedule" && (
            <ScheduleScreen
              agents={store.agents}
              schedules={store.schedules}
              scheduleViews={store.scheduleViews}
              selectedAgentId={store.selectedAgentId}
              onSelectAgent={store.selectAgent}
              onSaveSchedule={store.saveSchedule}
              onPreviewPlan={store.previewSchedulePlan}
              onRunSchedulerNow={store.runSchedulerNow}
              feedbackMessage={store.schedulerFeedback}
              onClearFeedback={store.clearSchedulerFeedback}
              status={store.sources.schedule}
              onRefresh={store.refreshSchedule}
              busy={store.busy}
            />
          )}

          {store.currentSection === "communication" && (
            <CommunicationScreen
              channels={store.channels}
              agents={store.agents}
              messages={store.messages}
              selectedAgentId={store.selectedAgentId}
              onSelectAgent={store.selectAgent}
              onSendMessage={store.sendDirectorMessage}
              status={store.sources.communication}
              onRefresh={() => void store.refreshConversation(store.selectedAgentId)}
              busy={store.busy}
            />
          )}

          {store.currentSection === "memory" && (
            <MemoryScreen
              agents={store.agents}
              entries={store.memoryEntries}
              selectedAgentId={store.selectedAgentId}
              onSelectAgent={store.selectAgent}
              status={store.sources.memory}
              onRefresh={() => void store.refreshMemory(store.selectedAgentId)}
            />
          )}

          {store.currentSection === "production" && (
            <ProductionScreen
              channels={store.channels}
              releases={store.releases}
              status={store.sources.production}
              onStartProduction={store.startProductionRelease}
              onRunStage={store.advancePipelineStage}
              onRefresh={store.refreshProduction}
              busy={store.busy}
            />
          )}

          {store.currentSection === "jobs" && (
            <JobsScreen metrics={store.metrics} status={store.sources.jobs} />
          )}

          {store.currentSection === "providers" && (
            <ProvidersQuotasScreen
              providers={store.providers}
              status={store.sources.providers}
              onRefresh={store.refreshProviders}
            />
          )}

          {store.currentSection === "connections" && (
            <ConnectionsScreen
              agents={store.agents}
              connections={store.connections}
              selectedAgentId={store.selectedAgentId}
              onSelectAgent={store.selectAgent}
              status={store.sources.connections}
              onRefresh={() => void store.refreshConnections(store.selectedAgentId)}
              backendGap={store.backendGaps.connectionWrite}
            />
          )}

          {store.currentSection === "approvals" && (
            <ApprovalsScreen
              approvals={store.approvals}
              status={store.sources.approvals}
              onRefresh={store.refreshApprovals}
              decisionGap={store.backendGaps.approvalDecision}
            />
          )}

          {store.currentSection === "notifications" && <NotificationsScreen />}

          {store.currentSection === "fleet" && <FleetScreen />}

          {store.currentSection === "evidence" && (
            <EvidenceScreen
              events={store.evidenceEvents}
              status={store.sources.evidence}
              currentFilter={store.evidenceFilter}
              onFilterChange={store.setEvidenceFilter}
              onRefresh={store.refreshEvidence}
            />
          )}

          {store.currentSection === "hermes" && (
            <HermesScreen
              overview={store.hermesOverview}
              decisions={store.hermesDecisions}
              status={store.sources.hermes}
              onRefresh={store.refreshHermes}
              availabilityGap={store.backendGaps.ownerAvailability}
              delegationGap={store.backendGaps.delegationPolicies}
            />
          )}

          {store.currentSection === "architecture" && <ArchitectureScreen />}

          {store.currentSection === "settings" && (
            <SettingsScreen
              owner={store.currentOwner}
              health={store.health}
              ready={store.ready}
              sessions={store.sessions}
              status={store.sources.settings}
              defaultPublishingMode={store.defaultPublishingMode}
              onPublishingModeChange={store.setDefaultPublishingMode}
              onLogout={store.logout}
              onRefresh={() => void store.restoreSession()}
              busy={store.busy}
            />
          )}
        </Suspense>
      </AppShell>

      {store.inspectionData && (
        <InspectionModal data={store.inspectionData} onDismiss={store.dismissInspection} />
      )}
    </>
  );
};

export default App;
