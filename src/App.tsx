import React from "react";
import { useProductionStore } from "./store/useProductionStore";
import { AppShell } from "./components/AppShell";
import { InspectionModal } from "./components/InspectionModal";
import { LoginScreen } from "./screens/LoginScreen";
import { OverviewScreen } from "./screens/OverviewScreen";
import { DirectorsScreen } from "./screens/DirectorsScreen";
import { ScheduleScreen } from "./screens/ScheduleScreen";
import { CommunicationScreen } from "./screens/CommunicationScreen";
import { MemoryScreen } from "./screens/MemoryScreen";
import { ProductionScreen } from "./screens/ProductionScreen";
import { JobsScreen } from "./screens/JobsScreen";
import { ProvidersQuotasScreen } from "./screens/ProvidersQuotasScreen";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { ApprovalsScreen } from "./screens/ApprovalsScreen";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { EvidenceScreen } from "./screens/EvidenceScreen";
import { HermesScreen } from "./screens/HermesScreen";
import { ArchitectureScreen } from "./screens/ArchitectureScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

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
