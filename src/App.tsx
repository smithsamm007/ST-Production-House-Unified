import React, { Suspense, lazy } from "react";
import { useProductionStore } from "./store/useProductionStore";
import { AppShell } from "./components/AppShell";
import { InspectionModal } from "./components/InspectionModal";
import { LoginScreen } from "./screens/LoginScreen";

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

export const App: React.FC = () => {
  const store = useProductionStore();

  if (!store.currentOwner) {
    return <LoginScreen onLogin={store.login} />;
  }

  const pendingApprovalsCount = store.approvals.filter(
    (a) => a.status === "pending"
  ).length;

  return (
    <>
      <AppShell
        owner={store.currentOwner}
        currentSection={store.currentSection}
        onNavigate={store.navigateTo}
        onLogout={store.logout}
        storageMode={store.storageMode}
        storageStatus={store.storageStatus}
        agentCount={store.agents.length}
        channelCount={store.channels.length}
        pendingApprovalsCount={pendingApprovalsCount}
        ownerAvailability={store.ownerAvailability}
      >
        <Suspense
          fallback={
            <div className="bg-[#0D1420] border border-[#1E2A40] rounded-xl p-8 text-xs text-[#8D9AB3]">
              Loading module...
            </div>
          }
        >
          {store.currentSection === "overview" && (
            <OverviewScreen
              channels={store.channels}
              releases={store.releases}
              jobs={store.jobs}
              agentCount={store.agents.length}
              ownerAvailability={store.ownerAvailability}
              onNavigate={store.navigateTo}
              onAdvanceRelease={store.advancePipelineStage}
              onInspectSlot={store.inspectArtifact}
            />
          )}

          {store.currentSection === "directors" && (
            <DirectorsScreen
              channels={store.channels}
              agents={store.agents}
              searchQuery={store.channelSearchQuery}
              onSearchQueryChange={store.setChannelSearchQuery}
              onAddChannel={store.addChannel}
              onInspectSlot={store.inspectArtifact}
            />
          )}

          {store.currentSection === "schedule" && (
            <ScheduleScreen
              channels={store.channels}
              schedules={store.schedules}
              selectedAgentId={store.selectedAgentId}
              onSelectAgent={store.selectAgent}
              onSaveSchedule={store.saveSchedule}
              onPreviewPlan={store.previewSchedulePlan}
              onRunSchedulerNow={store.runSchedulerNow}
              feedbackMessage={store.schedulerFeedback}
              onClearFeedback={store.clearSchedulerFeedback}
            />
          )}

          {store.currentSection === "communication" && (
            <CommunicationScreen
              channels={store.channels}
              messages={store.messages}
              selectedAgentId={store.selectedAgentId}
              onSelectAgent={store.selectAgent}
              onSendMessage={store.sendDirectorMessage}
              onRefreshMessages={store.refreshDirectorMessages}
            />
          )}

          {store.currentSection === "memory" && (
            <MemoryScreen
              channels={store.channels}
              charters={store.charters}
              selectedAgentId={store.selectedAgentId}
              onSelectAgent={store.selectAgent}
            />
          )}

          {store.currentSection === "production" && (
            <ProductionScreen
              channels={store.channels}
              releases={store.releases}
              onStartProduction={store.startProductionRelease}
              onAdvanceStage={store.advancePipelineStage}
            />
          )}

          {store.currentSection === "jobs" && (
            <JobsScreen
              jobs={store.jobs}
              currentFilter={store.jobStatusFilter}
              onFilterChange={store.setJobStatusFilter}
              onPauseJob={store.pauseJob}
              onResumeJob={store.resumeJob}
              onCancelJob={store.cancelJob}
            />
          )}

          {store.currentSection === "providers" && (
            <ProvidersQuotasScreen providers={store.providers} />
          )}

          {store.currentSection === "connections" && (
            <ConnectionsScreen
              connections={store.platformConnections}
              onUpdateSlot={store.updateConnectionSlot}
            />
          )}

          {store.currentSection === "approvals" && (
            <ApprovalsScreen
              approvals={store.approvals}
              onApprove={store.approveItem}
              onReject={store.rejectItem}
            />
          )}

          {store.currentSection === "notifications" && <NotificationsScreen />}

          {store.currentSection === "fleet" && <FleetScreen />}

          {store.currentSection === "evidence" && (
            <EvidenceScreen
              events={store.evidenceEvents}
              currentFilter={store.evidenceFilter}
              onFilterChange={store.setEvidenceFilter}
            />
          )}

          {store.currentSection === "hermes" && (
            <HermesScreen
              decisions={store.hermesDecisions}
              ownerAvailability={store.ownerAvailability}
              delegationPolicies={store.delegationPolicies}
              onChangeOwnerAvailability={store.setOwnerAvailability}
              onTogglePolicy={store.toggleDelegatedPolicy}
              onEvaluateDelegation={store.evaluateHermesDelegation}
            />
          )}

          {store.currentSection === "architecture" && <ArchitectureScreen />}

          {store.currentSection === "settings" && (
            <SettingsScreen
              owner={store.currentOwner}
              storageMode={store.storageMode}
              storageStatus={store.storageStatus}
              defaultPublishingMode={store.defaultPublishingMode}
              onPublishingModeChange={store.setDefaultPublishingMode}
              onLogout={store.logout}
              onResetToCanonical={store.resetToCanonical}
            />
          )}
        </Suspense>
      </AppShell>

      {store.inspectionData && (
        <InspectionModal
          data={store.inspectionData}
          onDismiss={store.dismissInspection}
        />
      )}
    </>
  );
};

export default App;
