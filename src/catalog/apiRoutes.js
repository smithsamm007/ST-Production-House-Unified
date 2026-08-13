// Phase 2: API Route Handlers for Agent, Charter, Reference, and Provider Management

export function registerAgentRoutes(app, { repositories }) {
  const {
    agentProfileRepo,
    charterRepo,
    referenceRepo,
    providerConfigRepo,
    credentialRepo,
    socialAccountRepo
  } = repositories;

  // ==================== AGENT MANAGEMENT ====================

  // GET /owners/:ownerId/agents
  app.get("/owners/:ownerId/agents", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const agents = await agentProfileRepo.listAgentProfiles({
        ownerId: req.params.ownerId
      });

      res.json({ agents });
    } catch (err) {
      console.error("List agents error", err.message);
      res.status(500).json({ error: "Failed to list agents" });
    }
  });

  // GET /owners/:ownerId/agents/:agentId
  app.get("/owners/:ownerId/agents/:agentId", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const agent = await agentProfileRepo.getAgentProfile({
        ownerId: req.params.ownerId,
        agentId: req.params.agentId
      });

      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      res.json(agent);
    } catch (err) {
      console.error("Get agent error", err.message);
      res.status(500).json({ error: "Failed to fetch agent" });
    }
  });

  // PUT /owners/:ownerId/agents/:agentId
  app.put("/owners/:ownerId/agents/:agentId", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const {
        publicBrandName,
        publicChannelName,
        publicNarratorIdentity,
        description,
        websiteUrl
      } = req.body;

      const updated = await agentProfileRepo.updateAgentProfile({
        ownerId: req.params.ownerId,
        agentId: req.params.agentId,
        publicBrandName,
        publicChannelName,
        publicNarratorIdentity,
        description,
        websiteUrl
      });

      res.json(updated);
    } catch (err) {
      console.error("Update agent error", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // ==================== CREATIVE CHARTERS ====================

  // GET /owners/:ownerId/charters
  app.get("/owners/:ownerId/charters", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const { agentId } = req.query;
      if (!agentId) {
        return res.status(400).json({ error: "agentId query parameter required" });
      }

      const charters = await charterRepo.listChartersForAgent({
        ownerId: req.params.ownerId,
        agentId
      });

      res.json({ charters });
    } catch (err) {
      console.error("List charters error", err.message);
      res.status(500).json({ error: "Failed to list charters" });
    }
  });

  // GET /owners/:ownerId/charters/:charterId
  app.get("/owners/:ownerId/charters/:charterId", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const { agentId } = req.query;
      if (!agentId) {
        return res.status(400).json({ error: "agentId query parameter required" });
      }

      const charter = await charterRepo.getCharter({
        ownerId: req.params.ownerId,
        agentId,
        charterId: req.params.charterId
      });

      if (!charter) {
        return res.status(404).json({ error: "Charter not found" });
      }

      res.json(charter);
    } catch (err) {
      console.error("Get charter error", err.message);
      res.status(500).json({ error: "Failed to fetch charter" });
    }
  });

  // GET /owners/:ownerId/charters/:charterId/versions
  app.get("/owners/:ownerId/charters/:charterId/versions", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const versions = await charterRepo.getCharterVersions({
        charterId: req.params.charterId
      });

      res.json({ versions });
    } catch (err) {
      console.error("Get charter versions error", err.message);
      res.status(500).json({ error: "Failed to fetch versions" });
    }
  });

  // POST /owners/:ownerId/charters/:charterId/approve
  app.post("/owners/:ownerId/charters/:charterId/approve", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const { agentId, versionNumber } = req.body;
      if (!agentId) {
        return res.status(400).json({ error: "agentId required" });
      }

      const result = await charterRepo.approveCharter({
        ownerId: req.params.ownerId,
        agentId,
        charterId: req.params.charterId,
        approvedByOwnerId: req.session.owner_id,
        versionNumber
      });

      res.json({ message: "Charter approved", result });
    } catch (err) {
      console.error("Approve charter error", err.message);
      res.status(500).json({ error: "Failed to approve charter" });
    }
  });

  // ==================== CREATIVE REFERENCES ====================

  // GET /owners/:ownerId/references
  app.get("/owners/:ownerId/references", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const { agentId, status } = req.query;
      if (!agentId) {
        return res.status(400).json({ error: "agentId query parameter required" });
      }

      const references = await referenceRepo.listReferences({
        ownerId: req.params.ownerId,
        agentId,
        status
      });

      res.json({ references });
    } catch (err) {
      console.error("List references error", err.message);
      res.status(500).json({ error: "Failed to list references" });
    }
  });

  // POST /owners/:ownerId/references
  app.post("/owners/:ownerId/references", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const {
        agentId,
        referenceType,
        title,
        description,
        sourceUrl,
        tags
      } = req.body;

      if (!agentId || !referenceType || !title) {
        return res
          .status(400)
          .json({ error: "agentId, referenceType, title required" });
      }

      const result = await referenceRepo.submitReference({
        ownerId: req.params.ownerId,
        agentId,
        referenceType,
        title,
        description,
        sourceUrl,
        tags
      });

      res.status(201).json(result);
    } catch (err) {
      console.error("Submit reference error", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // GET /owners/:ownerId/references/:refId
  app.get("/owners/:ownerId/references/:refId", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const reference = await referenceRepo.getReference({
        ownerId: req.params.ownerId,
        referenceId: req.params.refId
      });

      if (!reference) {
        return res.status(404).json({ error: "Reference not found" });
      }

      res.json(reference);
    } catch (err) {
      console.error("Get reference error", err.message);
      res.status(500).json({ error: "Failed to fetch reference" });
    }
  });

  // POST /owners/:ownerId/references/:refId/approve
  app.post("/owners/:ownerId/references/:refId/approve", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const result = await referenceRepo.approveReference({
        ownerId: req.params.ownerId,
        referenceId: req.params.refId,
        approvedByOwnerId: req.session.owner_id
      });

      if (!result) {
        return res.status(404).json({ error: "Reference not found" });
      }

      res.json({ message: "Reference approved", result });
    } catch (err) {
      console.error("Approve reference error", err.message);
      res.status(500).json({ error: "Failed to approve reference" });
    }
  });

  // ==================== PROVIDER CONFIGURATION ====================

  // GET /owners/:ownerId/providers
  app.get("/owners/:ownerId/providers", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const { agentId } = req.query;
      if (!agentId) {
        return res.status(400).json({ error: "agentId query parameter required" });
      }

      const configs = await providerConfigRepo.listProviderConfigs({
        ownerId: req.params.ownerId,
        agentId
      });

      res.json({ providers: configs });
    } catch (err) {
      console.error("List providers error", err.message);
      res.status(500).json({ error: "Failed to list providers" });
    }
  });

  // POST /owners/:ownerId/providers
  app.post("/owners/:ownerId/providers", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const {
        agentId,
        slot,
        provider,
        credentialId,
        apiVersion,
        timeoutMs,
        retryLimit
      } = req.body;

      if (!agentId || !slot || !provider) {
        return res
          .status(400)
          .json({ error: "agentId, slot, provider required" });
      }

      const config = await providerConfigRepo.createProviderConfig({
        ownerId: req.params.ownerId,
        agentId,
        slot,
        provider,
        credentialId,
        apiVersion,
        timeoutMs,
        retryLimit
      });

      res.status(201).json(config);
    } catch (err) {
      console.error("Create provider config error", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /owners/:ownerId/providers/:providerId
  app.delete("/owners/:ownerId/providers/:providerId", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const { agentId } = req.query;
      if (!agentId) {
        return res.status(400).json({ error: "agentId query parameter required" });
      }

      const result = await providerConfigRepo.disableProviderConfig({
        ownerId: req.params.ownerId,
        agentId,
        configId: req.params.providerId
      });

      if (!result) {
        return res.status(404).json({ error: "Provider not found" });
      }

      res.json({ message: "Provider disabled", result });
    } catch (err) {
      console.error("Disable provider error", err.message);
      res.status(500).json({ error: "Failed to disable provider" });
    }
  });

  // ==================== CREDENTIALS ====================

  // GET /owners/:ownerId/credentials
  app.get("/owners/:ownerId/credentials", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const { agentId } = req.query;
      if (!agentId) {
        return res.status(400).json({ error: "agentId query parameter required" });
      }

      const credentials = await credentialRepo.listCredentials({
        ownerId: req.params.ownerId,
        agentId
      });

      res.json({ credentials });
    } catch (err) {
      console.error("List credentials error", err.message);
      res.status(500).json({ error: "Failed to list credentials" });
    }
  });

  // POST /owners/:ownerId/credentials
  app.post("/owners/:ownerId/credentials", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const {
        agentId,
        provider,
        credentialName,
        vaultLocator
      } = req.body;

      if (!agentId || !provider || !credentialName || !vaultLocator) {
        return res
          .status(400)
          .json({
            error: "agentId, provider, credentialName, vaultLocator required"
          });
      }

      const result = await credentialRepo.registerCredential({
        ownerId: req.params.ownerId,
        agentId,
        provider,
        credentialName,
        vaultLocator
      });

      res.status(201).json(result);
    } catch (err) {
      console.error("Register credential error", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // ==================== SOCIAL ACCOUNTS ====================

  // GET /owners/:ownerId/agents/:agentId/social-accounts
  app.get("/owners/:ownerId/agents/:agentId/social-accounts", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const accounts = await socialAccountRepo.listSocialAccounts({
        ownerId: req.params.ownerId,
        agentId: req.params.agentId
      });

      res.json({ accounts });
    } catch (err) {
      console.error("List social accounts error", err.message);
      res.status(500).json({ error: "Failed to list social accounts" });
    }
  });

  // POST /owners/:ownerId/agents/:agentId/social-accounts
  app.post("/owners/:ownerId/agents/:agentId/social-accounts", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const { platform, channelName, channelId } = req.body;
      if (!platform || !channelName) {
        return res.status(400).json({ error: "platform, channelName required" });
      }

      const result = await socialAccountRepo.addSocialAccount({
        ownerId: req.params.ownerId,
        agentId: req.params.agentId,
        platform,
        channelName,
        channelId
      });

      res.status(201).json(result);
    } catch (err) {
      console.error("Add social account error", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /owners/:ownerId/agents/:agentId/social-accounts/:accountId
  app.delete(
    "/owners/:ownerId/agents/:agentId/social-accounts/:accountId",
    async (req, res) => {
      try {
        if (!req.session || req.session.owner_id !== req.params.ownerId) {
          return res.status(403).json({ error: "Unauthorized" });
        }

        const result = await socialAccountRepo.removeSocialAccount({
          ownerId: req.params.ownerId,
          agentId: req.params.agentId,
          accountId: req.params.accountId
        });

        res.json({ message: "Social account removed", result });
      } catch (err) {
        console.error("Remove social account error", err.message);
        res.status(500).json({ error: "Failed to remove social account" });
      }
    }
  );
}
