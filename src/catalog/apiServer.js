// Phase 2: Express API Server with Authentication and Policy Enforcement
// Entry point for owner dashboard and worker management.

import express from "express";
import {
  PasswordHasher,
  SessionManager,
  CsrfProtection
} from "./auth/passwordAndSession.js";

export function createApiServer({
  adapter,
  credentialBroker,
  quarantineRepository,
  ownerAlertsRepository,
  emergencyPauseRepository,
  circuitBreakerRepository,
  port = process.env.PORT || 3000
} = {}) {
  if (!adapter) throw new Error("API server requires PostgreSQL adapter");

  const app = express();
  const passwordHasher = new PasswordHasher({
    timeCost: 3,
    memoryCost: 65536,
    parallelism: 4
  });
  const sessionManager = new SessionManager({
    adapter,
    sessionTimeoutMs: 3600000 // 1 hour
  });

  // Middleware
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ limit: "10mb", extended: true }));

  // Request logging middleware
  app.use((req, res, next) => {
    const startTime = Date.now();
    const requestId = require("crypto").randomBytes(8).toString("hex");
    req.id = requestId;

    res.on("finish", () => {
      const duration = Date.now() - startTime;
      console.log(
        JSON.stringify({
          type: "http_request",
          requestId,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: duration,
          ownerId: req.session?.ownerId || "anonymous"
        })
      );
    });

    next();
  });

  // Session middleware
  app.use(async (req, res, next) => {
    const sessionToken = req.cookies?.sessionToken;
    if (sessionToken) {
      try {
        const session = await sessionManager.getSession({ sessionToken });
        if (session) {
          req.session = session;
        }
      } catch (err) {
        console.error("Session validation error", err.message);
      }
    }
    next();
  });

  // CSRF validation for mutations
  const validateCsrf = async (req, res, next) => {
    if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
      const providedToken = CsrfProtection.extractToken({
        body: req.body,
        headers: req.headers
      });
      if (
        !providedToken ||
        !req.session ||
        !CsrfProtection.validateToken({
          providedToken,
          sessionCsrfToken: req.session.csrf_token
        })
      ) {
        return res.status(403).json({ error: "CSRF validation failed" });
      }
    }
    next();
  };
  app.use(validateCsrf);

  // ==================== HEALTH CHECK ====================
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ==================== AUTHENTICATION ====================

  // POST /auth/register
  app.post("/auth/register", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res
          .status(400)
          .json({ error: "email and password required" });
      }

      if (password.length < 8 || password.length > 256) {
        return res
          .status(400)
          .json({ error: "password must be 8-256 characters" });
      }

      const passwordHash = await passwordHasher.hash(password);

      const conn = await adapter.getConnection();
      try {
        const result = await conn.query(
          `
          INSERT INTO owners (email, auth_method)
          VALUES ($1, 'password')
          ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
          RETURNING id, email
          `,
          [email]
        );

        const owner = result.rows[0];
        if (!owner) {
          return res.status(500).json({ error: "Failed to create owner" });
        }

        await conn.query(
          `
          INSERT INTO owner_password_hashes (owner_id, hash)
          VALUES ($1, $2)
          ON CONFLICT (owner_id) DO UPDATE SET hash = EXCLUDED.hash
          `,
          [owner.id, passwordHash]
        );

        res.status(201).json({
          ownerId: owner.id,
          email: owner.email,
          message: "Owner registered successfully"
        });
      } finally {
        await conn.release();
      }
    } catch (err) {
      console.error("Registration error", err.message);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  // POST /auth/login
  app.post("/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res
          .status(400)
          .json({ error: "email and password required" });
      }

      const conn = await adapter.getConnection();
      try {
        const ownerResult = await conn.query(
          `
          SELECT id, email FROM owners WHERE email = $1
          `,
          [email]
        );

        if (ownerResult.rows.length === 0) {
          return res.status(401).json({ error: "Invalid credentials" });
        }

        const owner = ownerResult.rows[0];

        const hashResult = await conn.query(
          `
          SELECT hash FROM owner_password_hashes WHERE owner_id = $1
          `,
          [owner.id]
        );

        if (hashResult.rows.length === 0) {
          return res.status(401).json({ error: "Invalid credentials" });
        }

        const passwordValid = await passwordHasher.verify(
          password,
          hashResult.rows[0].hash
        );

        if (!passwordValid) {
          return res.status(401).json({ error: "Invalid credentials" });
        }

        // Create session
        const session = await sessionManager.createSession({
          ownerId: owner.id,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] || ""
        });

        // Set secure cookie
        res.cookie("sessionToken", session.sessionToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 3600000 // 1 hour
        });

        res.json({
          ownerId: owner.id,
          email: owner.email,
          sessionId: session.sessionId,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt
        });
      } finally {
        await conn.release();
      }
    } catch (err) {
      console.error("Login error", err.message);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // POST /auth/logout
  app.post("/auth/logout", async (req, res) => {
    try {
      if (!req.session) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const sessionToken = req.cookies?.sessionToken;
      if (sessionToken) {
        await sessionManager.revokeSession({ sessionToken });
      }

      res.clearCookie("sessionToken");
      res.json({ message: "Logged out successfully" });
    } catch (err) {
      console.error("Logout error", err.message);
      res.status(500).json({ error: "Logout failed" });
    }
  });

  // GET /auth/status
  app.get("/auth/status", async (req, res) => {
    try {
      if (!req.session) {
        return res.json({ authenticated: false });
      }

      const conn = await adapter.getConnection();
      try {
        const result = await conn.query(
          `
          SELECT id, email FROM owners WHERE id = $1
          `,
          [req.session.owner_id]
        );

        if (result.rows.length === 0) {
          return res.json({ authenticated: false });
        }

        const owner = result.rows[0];
        res.json({
          authenticated: true,
          ownerId: owner.id,
          email: owner.email,
          expiresAt: req.session.expires_at
        });
      } finally {
        await conn.release();
      }
    } catch (err) {
      console.error("Status check error", err.message);
      res.status(500).json({ error: "Status check failed" });
    }
  });

  // ==================== RESILIENCE CONTROLS ====================

  // GET /owners/:ownerId/emergency-pause
  app.get("/owners/:ownerId/emergency-pause", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      if (!emergencyPauseRepository) {
        return res.status(501).json({ error: "Emergency pause not available" });
      }

      const status = await emergencyPauseRepository.getPauseStatus({
        ownerId: req.params.ownerId
      });

      res.json(status);
    } catch (err) {
      console.error("Emergency pause status error", err.message);
      res.status(500).json({ error: "Failed to fetch pause status" });
    }
  });

  // POST /owners/:ownerId/emergency-pause/activate
  app.post("/owners/:ownerId/emergency-pause/activate", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      if (!emergencyPauseRepository) {
        return res.status(501).json({ error: "Emergency pause not available" });
      }

      const { pausedReason } = req.body;
      if (!pausedReason) {
        return res.status(400).json({ error: "pausedReason required" });
      }

      const result = await emergencyPauseRepository.pause({
        ownerId: req.params.ownerId,
        pausedByOwnerId: req.session.owner_id,
        pausedReason
      });

      if (!result) {
        return res.status(400).json({ error: "Already paused" });
      }

      res.json({
        message: "Emergency pause activated",
        status: result
      });
    } catch (err) {
      console.error("Emergency pause activate error", err.message);
      res.status(500).json({ error: "Failed to activate pause" });
    }
  });

  // POST /owners/:ownerId/emergency-pause/resume
  app.post("/owners/:ownerId/emergency-pause/resume", async (req, res) => {
    try {
      if (!req.session || req.session.owner_id !== req.params.ownerId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      if (!emergencyPauseRepository) {
        return res.status(501).json({ error: "Emergency pause not available" });
      }

      const { resumedReason } = req.body;
      if (!resumedReason) {
        return res.status(400).json({ error: "resumedReason required" });
      }

      const result = await emergencyPauseRepository.resume({
        ownerId: req.params.ownerId,
        resumedByOwnerId: req.session.owner_id,
        resumedReason
      });

      if (!result) {
        return res.status(400).json({ error: "Not paused" });
      }

      res.json({
        message: "Emergency pause resumed",
        status: result
      });
    } catch (err) {
      console.error("Emergency pause resume error", err.message);
      res.status(500).json({ error: "Failed to resume operations" });
    }
  });

  // ==================== ERROR HANDLING ====================
  app.use((err, req, res, next) => {
    console.error("Unhandled error", err.message);
    res.status(500).json({ error: "Internal server error" });
  });

  // ==================== START SERVER ====================
  return {
    app,
    start: async () => {
      return new Promise((resolve) => {
        const server = app.listen(port, () => {
          console.log(`API server listening on port ${port}`);
          resolve(server);
        });
      });
    }
  };
}

export default createApiServer;
