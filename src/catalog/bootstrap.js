import { registerOwner, normalizeEmail, validatePasswordStrength } from "./ownerAuthentication.js";
import { OwnerRepository } from "./repositories.js";

const ownersRepo = new OwnerRepository();
const usePg = !!process.env.DATABASE_URL;

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

  // Prevent multiple owners by checking if any exist in the repository
  if (usePg) {
    const existing = await ownersRepo.findByEmail(normEmail);
    if (existing) {
      console.log("Bootstrap owner already exists in PostgreSQL database. Skipping creation.");
      return { status: "exists", ownerId: existing.id };
    }
  }

  // Create the owner
  const owner = await registerOwner(normEmail, password, "owner");
  console.log(`Successfully bootstrapped initial owner account: ${normEmail} (ID: ${owner.id})`);
  return { status: "created", ownerId: owner.id };
}

// Support running directly from command line
if (process.argv[1]?.endsWith("bootstrap.js")) {
  bootstrapOwner()
    .then((res) => {
      console.log("Bootstrap script completed:", res);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Bootstrap script failed:", err.message);
      process.exit(1);
    });
}
