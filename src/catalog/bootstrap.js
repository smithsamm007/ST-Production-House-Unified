import { registerOwner, normalizeEmail, validatePasswordStrength } from "./ownerAuthentication.js";
import { OwnerRepository, configureRepositoryAdapter } from "./repositories.js";
import { createPostgresAdapter, sanitizeError } from "../db/index.js";

/**
 * Bootstraps the initial owner of the ST Production House platform.
 * Relies on BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD environment variables.
 */
export async function bootstrapOwner() {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL;
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;

  if (!email || !password) {
    console.warn("BOOTSTRAP_WARNING: BOOTSTRAP_OWNER_EMAIL or BOOTSTRAP_OWNER_PASSWORD environment variables are not set. Skipping bootstrap.");
    return { status: "skipped", reason: "MISSING_ENV_VARS" };
  }

  const normEmail = normalizeEmail(email);
  if (!normEmail || !normEmail.includes("@")) {
    throw new Error("BOOTSTRAP_ERROR: Invalid email address format");
  }

  // Enforce password strength
  validatePasswordStrength(password);

  configureRepositoryAdapter(createPostgresAdapter());

  // Create the owner
  const owner = await registerOwner(normEmail, password, "owner");
  return { status: "created", ownerId: owner.id };
}

// Support running directly from command line
if (process.argv[1]?.endsWith("bootstrap.js")) {
  bootstrapOwner()
    .then((res) => {
      console.log(JSON.stringify({ code: "BOOTSTRAP_COMPLETE", status: res.status }));
      process.exit(0);
    })
    .catch((err) => {
      const sanitized = sanitizeError(err);
      console.warn(JSON.stringify({ code: "BOOTSTRAP_FAILED", errorName: sanitized.name || "Error" }));
      process.exit(1);
    });
}
