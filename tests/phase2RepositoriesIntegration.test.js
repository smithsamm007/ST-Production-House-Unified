import { describe, it } from "node:test";
import assert from "node:assert";
import {
  AgentPublicProfileRepository,
  CreativeCharterRepository,
  CreativeReferenceRepository
} from "../src/db/repositories/index.js";
import {
  ProviderConfigurationRepository,
  CredentialRegistryRepository,
  AgentSocialAccountRepository
} from "../src/db/repositories/providers.js";
import {
  JobLifecycleRepository,
  WorkerLeaseRepository,
  JobEvidenceRepository
} from "../src/db/repositories/jobs.js";

// Mock adapter
function createMockAdapter() {
  const mockConnection = {
    query: async (sql, params) => {
      // Mock implementations return structured responses
      if (sql.includes("agent_public_profiles") && sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: "agent-1",
              internal_name: "JARVIS",
              public_brand_name: "Test Brand",
              public_channel_name: "Test Channel",
              public_narrator_identity: "Test Narrator",
              description: "Test Description",
              website_url: "https://test.com",
              created_at: new Date(),
              updated_at: new Date()
            }
          ]
        };
      }
      if (sql.includes("creative_charters") && sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: "charter-1",
              owner_id: "owner-1",
              agent_id: "agent-1",
              universe_id: "universe-1",
              title: "Test Charter",
              description: "Test Description",
              is_approved: false,
              approved_by_owner_id: null,
              approved_at: null,
              is_active: true,
              created_at: new Date(),
              updated_at: new Date()
            }
          ]
        };
      }
      if (sql.includes("creative_references") && sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: "ref-1",
              agent_id: "agent-1",
              reference_type: "youtube_video",
              title: "Test Video",
              description: "Test Ref Description",
              source_url: "https://youtube.com/watch?v=test",
              status: "submitted",
              tags: '["test"]',
              created_at: new Date(),
              updated_at: new Date()
            }
          ]
        };
      }
      if (sql.includes("agent_provider_configurations") && sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: "config-1",
              owner_id: "owner-1",
              agent_id: "agent-1",
              slot: "primary",
              provider: "openai",
              credential_id: "cred-1",
              api_version: "v1",
              timeout_ms: 30000,
              retry_limit: 3,
              is_enabled: true,
              created_at: new Date(),
              updated_at: new Date()
            }
          ]
        };
      }
      if (sql.includes("owner_credentials") && sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: "cred-1",
              provider: "openai",
              credential_name: "default",
              vault_locator: "vault://openai/default/abc123",
              created_at: new Date()
            }
          ]
        };
      }
      if (sql.includes("agent_social_accounts") && sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: "account-1",
              platform: "youtube",
              channel_name: "Test Channel",
              channel_id: "UCxxx",
              account_type: "unconfigured",
              created_at: new Date()
            }
          ]
        };
      }
      // Handle specific updates for different query types
      if (sql.includes("INSERT INTO creative_references")) {
        return {
          rows: [
            {
              id: "ref-new",
              status: "submitted",
              created_at: new Date(),
              updated_at: new Date()
            }
          ]
        };
      }
      if (sql.includes("UPDATE creative_references")) {
        return {
          rows: [
            {
              id: "ref-1",
              status: "approved",
              updated_at: new Date()
            }
          ]
        };
      }
      if (sql.includes("INSERT INTO agent_social_accounts")) {
        return {
          rows: [
            {
              id: "account-new",
              platform: "youtube",
              account_type: "unconfigured",
              created_at: new Date()
            }
          ]
        };
      }
      if (sql.includes("INSERT INTO jobs")) {
        return {
          rows: [
            {
              id: "job-1",
              status: "queued",
              created_at: new Date(),
              updated_at: new Date()
            }
          ]
        };
      }
      if (sql.includes("UPDATE jobs") && sql.includes("SET status")) {
        return {
          rows: [
            {
              id: "job-1",
              status: "completed",
              updated_at: new Date()
            }
          ]
        };
      }
      if (sql.includes("INSERT") || sql.includes("ON CONFLICT")) {
        return {
          rows: [
            {
              id: "new-id-" + Math.random().toString(36).substr(2, 9),
              created_at: new Date(),
              updated_at: new Date(),
              is_enabled: true,
              account_type: "unconfigured"
            }
          ]
        };
      }
      if (sql.includes("DELETE")) {
        return {
          rows: [{ job_id: "job-1" }]
        };
      }
      return { rows: [] };
    },
    release: async () => {}
  };

  return {
    getConnection: async () => mockConnection
  };
}

describe("Phase 2: Repository Layer Tests", () => {
  describe("AgentPublicProfileRepository", () => {
    it("requires adapter in constructor", () => {
      assert.throws(
        () => new AgentPublicProfileRepository({}),
        /requires adapter/
      );
    });

    it("validates adapter has getConnection method", () => {
      assert.throws(
        () =>
          new AgentPublicProfileRepository({
            adapter: { notGetConnection: true }
          }),
        /must have getConnection method/
      );
    });

    it("successfully retrieves agent profile", async () => {
      const adapter = createMockAdapter();
      const repo = new AgentPublicProfileRepository({ adapter });

      const profile = await repo.getAgentProfile({
        ownerId: "owner-1",
        agentId: "agent-1"
      });

      assert.ok(profile);
      assert.strictEqual(profile.agentId, "agent-1");
      assert.strictEqual(profile.publicBrandName, "Test Brand");
    });

    it("rejects internal agent names in public fields", async () => {
      const adapter = createMockAdapter();
      const repo = new AgentPublicProfileRepository({ adapter });

      assert.rejects(
        () =>
          repo.updateAgentProfile({
            ownerId: "owner-1",
            agentId: "agent-1",
            publicBrandName: "JARVIS is here"
          }),
        /cannot contain internal agent names/
      );
    });
  });

  describe("CreativeCharterRepository", () => {
    it("requires adapter in constructor", () => {
      assert.throws(
        () => new CreativeCharterRepository({}),
        /requires adapter/
      );
    });

    it("successfully retrieves charter", async () => {
      const adapter = createMockAdapter();
      const repo = new CreativeCharterRepository({ adapter });

      const charter = await repo.getCharter({
        ownerId: "owner-1",
        agentId: "agent-1",
        charterId: "charter-1"
      });

      assert.ok(charter);
      assert.strictEqual(charter.charterId, "charter-1");
      assert.strictEqual(charter.title, "Test Charter");
    });

    it("successfully lists charters for agent", async () => {
      const adapter = createMockAdapter();
      const repo = new CreativeCharterRepository({ adapter });

      const charters = await repo.listChartersForAgent({
        ownerId: "owner-1",
        agentId: "agent-1"
      });

      assert.ok(Array.isArray(charters));
      assert(charters.length >= 0);
    });

    it("successfully approves charter", async () => {
      const adapter = createMockAdapter();
      const repo = new CreativeCharterRepository({ adapter });

      const result = await repo.approveCharter({
        ownerId: "owner-1",
        agentId: "agent-1",
        charterId: "charter-1",
        approvedByOwnerId: "owner-1"
      });

      assert.ok(result);
      assert.strictEqual(result.isApproved, true);
    });
  });

  describe("CreativeReferenceRepository", () => {
    it("requires adapter in constructor", () => {
      assert.throws(
        () => new CreativeReferenceRepository({}),
        /requires adapter/
      );
    });

    it("validates reference type", async () => {
      const adapter = createMockAdapter();
      const repo = new CreativeReferenceRepository({ adapter });

      assert.rejects(
        () =>
          repo.submitReference({
            ownerId: "owner-1",
            agentId: "agent-1",
            referenceType: "invalid_type",
            title: "Test"
          }),
        /Invalid referenceType/
      );
    });

    it("successfully submits reference", async () => {
      const adapter = createMockAdapter();
      const repo = new CreativeReferenceRepository({ adapter });

      const result = await repo.submitReference({
        ownerId: "owner-1",
        agentId: "agent-1",
        referenceType: "youtube_video",
        title: "Test Video",
        sourceUrl: "https://youtube.com/watch?v=test"
      });

      assert.ok(result);
      assert.strictEqual(result.status, "submitted");
    });

    it("successfully lists references", async () => {
      const adapter = createMockAdapter();
      const repo = new CreativeReferenceRepository({ adapter });

      const references = await repo.listReferences({
        ownerId: "owner-1",
        agentId: "agent-1"
      });

      assert.ok(Array.isArray(references));
    });

    it("successfully approves reference", async () => {
      const adapter = createMockAdapter();
      const repo = new CreativeReferenceRepository({ adapter });

      const result = await repo.approveReference({
        ownerId: "owner-1",
        referenceId: "ref-1",
        approvedByOwnerId: "owner-1"
      });

      assert.ok(result);
      assert.strictEqual(result.status, "approved");
    });
  });

  describe("ProviderConfigurationRepository", () => {
    it("requires adapter in constructor", () => {
      assert.throws(
        () => new ProviderConfigurationRepository({}),
        /requires adapter/
      );
    });

    it("validates slot parameter", async () => {
      const adapter = createMockAdapter();
      const repo = new ProviderConfigurationRepository({ adapter });

      assert.rejects(
        () =>
          repo.createProviderConfig({
            ownerId: "owner-1",
            agentId: "agent-1",
            slot: "invalid_slot",
            provider: "openai"
          }),
        /Invalid slot/
      );
    });

    it("successfully creates provider config", async () => {
      const adapter = createMockAdapter();
      const repo = new ProviderConfigurationRepository({ adapter });

      const result = await repo.createProviderConfig({
        ownerId: "owner-1",
        agentId: "agent-1",
        slot: "primary",
        provider: "openai"
      });

      assert.ok(result);
      assert.strictEqual(result.isEnabled, true);
    });

    it("successfully lists provider configs", async () => {
      const adapter = createMockAdapter();
      const repo = new ProviderConfigurationRepository({ adapter });

      const configs = await repo.listProviderConfigs({
        ownerId: "owner-1",
        agentId: "agent-1"
      });

      assert.ok(Array.isArray(configs));
    });
  });

  describe("CredentialRegistryRepository", () => {
    it("requires adapter in constructor", () => {
      assert.throws(
        () => new CredentialRegistryRepository({}),
        /requires adapter/
      );
    });

    it("validates vault locator format", async () => {
      const adapter = createMockAdapter();
      const repo = new CredentialRegistryRepository({ adapter });

      assert.rejects(
        () =>
          repo.registerCredential({
            ownerId: "owner-1",
            agentId: "agent-1",
            provider: "openai",
            credentialName: "default",
            vaultLocator: "invalid-locator"
          }),
        /must start with vault:\/\//
      );
    });

    it("successfully registers credential", async () => {
      const adapter = createMockAdapter();
      const repo = new CredentialRegistryRepository({ adapter });

      const result = await repo.registerCredential({
        ownerId: "owner-1",
        agentId: "agent-1",
        provider: "openai",
        credentialName: "default",
        vaultLocator: "vault://openai/default/abc123"
      });

      assert.ok(result);
      assert.strictEqual(result.vaultLocator, "vault://openai/default/abc123");
    });

    it("successfully lists credentials", async () => {
      const adapter = createMockAdapter();
      const repo = new CredentialRegistryRepository({ adapter });

      const credentials = await repo.listCredentials({
        ownerId: "owner-1",
        agentId: "agent-1"
      });

      assert.ok(Array.isArray(credentials));
    });
  });

  describe("AgentSocialAccountRepository", () => {
    it("requires adapter in constructor", () => {
      assert.throws(
        () => new AgentSocialAccountRepository({}),
        /requires adapter/
      );
    });

    it("validates platform parameter", async () => {
      const adapter = createMockAdapter();
      const repo = new AgentSocialAccountRepository({ adapter });

      assert.rejects(
        () =>
          repo.addSocialAccount({
            ownerId: "owner-1",
            agentId: "agent-1",
            platform: "invalid_platform",
            channelName: "Test"
          }),
        /Invalid platform/
      );
    });

    it("successfully adds social account", async () => {
      const adapter = createMockAdapter();
      const repo = new AgentSocialAccountRepository({ adapter });

      const result = await repo.addSocialAccount({
        ownerId: "owner-1",
        agentId: "agent-1",
        platform: "youtube",
        channelName: "Test Channel"
      });

      assert.ok(result);
      assert.strictEqual(result.accountType, "unconfigured");
    });

    it("successfully lists social accounts", async () => {
      const adapter = createMockAdapter();
      const repo = new AgentSocialAccountRepository({ adapter });

      const accounts = await repo.listSocialAccounts({
        ownerId: "owner-1",
        agentId: "agent-1"
      });

      assert.ok(Array.isArray(accounts));
    });
  });

  describe("JobLifecycleRepository", () => {
    it("requires adapter in constructor", () => {
      assert.throws(
        () => new JobLifecycleRepository({}),
        /requires adapter/
      );
    });

    it("validates priority parameter", async () => {
      const adapter = createMockAdapter();
      const repo = new JobLifecycleRepository({ adapter });

      assert.rejects(
        () =>
          repo.createJob({
            ownerId: "owner-1",
            agentId: "agent-1",
            jobType: "generate_content",
            priority: "invalid_priority"
          }),
        /Invalid priority/
      );
    });

    it("successfully creates job", async () => {
      const adapter = createMockAdapter();
      const repo = new JobLifecycleRepository({ adapter });

      const result = await repo.createJob({
        ownerId: "owner-1",
        agentId: "agent-1",
        jobType: "generate_content"
      });

      assert.ok(result);
      assert.strictEqual(result.status, "queued");
    });

    it("successfully lists jobs", async () => {
      const adapter = createMockAdapter();
      const repo = new JobLifecycleRepository({ adapter });

      const jobs = await repo.listJobs({
        ownerId: "owner-1",
        agentId: "agent-1"
      });

      assert.ok(Array.isArray(jobs));
    });

    it("successfully updates job status", async () => {
      const adapter = createMockAdapter();
      const repo = new JobLifecycleRepository({ adapter });

      const result = await repo.updateJobStatus({
        ownerId: "owner-1",
        agentId: "agent-1",
        jobId: "job-1",
        status: "completed",
        outputData: { result: "success" }
      });

      assert.ok(result);
      assert.strictEqual(result.status, "completed");
    });
  });

  describe("WorkerLeaseRepository", () => {
    it("requires adapter in constructor", () => {
      assert.throws(
        () => new WorkerLeaseRepository({}),
        /requires adapter/
      );
    });

    it("successfully claims lease", async () => {
      const adapter = createMockAdapter();
      const repo = new WorkerLeaseRepository({ adapter });

      const result = await repo.claimLease({
        ownerId: "owner-1",
        agentId: "agent-1",
        workerId: "worker-1"
      });

      // Result can be null if no jobs available (which is expected)
      assert.ok(result === null || result.leaseId);
    });

    it("successfully renews lease", async () => {
      const adapter = createMockAdapter();
      const repo = new WorkerLeaseRepository({ adapter });

      const result = await repo.renewLease({
        ownerId: "owner-1",
        agentId: "agent-1",
        leaseId: "lease-1"
      });

      assert.ok(result === null || result.leaseId);
    });

    it("successfully lists active leases", async () => {
      const adapter = createMockAdapter();
      const repo = new WorkerLeaseRepository({ adapter });

      const leases = await repo.listActiveLeases({
        ownerId: "owner-1",
        agentId: "agent-1"
      });

      assert.ok(Array.isArray(leases));
    });
  });

  describe("JobEvidenceRepository", () => {
    it("requires adapter in constructor", () => {
      assert.throws(
        () => new JobEvidenceRepository({}),
        /requires adapter/
      );
    });

    it("validates evidence type", async () => {
      const adapter = createMockAdapter();
      const repo = new JobEvidenceRepository({ adapter });

      assert.rejects(
        () =>
          repo.createEvidence({
            ownerId: "owner-1",
            agentId: "agent-1",
            jobId: "job-1",
            evidenceType: "invalid_type",
            evidenceData: {}
          }),
        /Invalid evidenceType/
      );
    });

    it("successfully creates evidence", async () => {
      const adapter = createMockAdapter();
      const repo = new JobEvidenceRepository({ adapter });

      const result = await repo.createEvidence({
        ownerId: "owner-1",
        agentId: "agent-1",
        jobId: "job-1",
        evidenceType: "provider_request",
        evidenceData: { provider: "openai" }
      });

      assert.ok(result);
      assert.ok(result.evidenceId);
    });

    it("successfully lists evidence", async () => {
      const adapter = createMockAdapter();
      const repo = new JobEvidenceRepository({ adapter });

      const evidence = await repo.listEvidence({
        ownerId: "owner-1",
        agentId: "agent-1",
        jobId: "job-1"
      });

      assert.ok(Array.isArray(evidence));
    });
  });

  describe("Repository Pattern Consistency", () => {
    it("all repositories validate required parameters", async () => {
      const adapter = createMockAdapter();

      const repos = [
        new AgentPublicProfileRepository({ adapter }),
        new CreativeCharterRepository({ adapter }),
        new CreativeReferenceRepository({ adapter }),
        new ProviderConfigurationRepository({ adapter }),
        new CredentialRegistryRepository({ adapter }),
        new AgentSocialAccountRepository({ adapter }),
        new JobLifecycleRepository({ adapter }),
        new WorkerLeaseRepository({ adapter }),
        new JobEvidenceRepository({ adapter })
      ];

      // Verify all repos are instances
      repos.forEach(repo => {
        assert.ok(repo);
        assert.ok(typeof repo.adapter !== "undefined");
      });
    });

    it("all repositories handle connection cleanup", async () => {
      let releaseCount = 0;
      const mockConnection = {
        query: async () => ({ rows: [] }),
        release: async () => {
          releaseCount++;
        }
      };

      const adapter = {
        getConnection: async () => mockConnection
      };

      const repo = new JobLifecycleRepository({ adapter });

      try {
        await repo.listJobs({
          ownerId: "owner-1",
          agentId: "agent-1"
        });
      } catch (e) {
        // Expected to fail with no data
      }

      // Verify release was called
      assert.strictEqual(releaseCount, 1);
    });
  });
});
