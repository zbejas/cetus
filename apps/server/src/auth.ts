import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { eq, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import * as schema from "./db/schema.ts";
import { authSecret, config, trustedOrigins } from "./config.ts";
import { openSecret } from "./lib/secrets.ts";

const oidcClientSecret = openSecret(config.oidc.clientSecretSealed);
const oidcEnabled = config.oidcActive && Boolean(oidcClientSecret);

export const auth = betterAuth({
  baseURL: config.publicUrl,
  secret: authSecret,
  trustedOrigins: (request) => {
    const origins = [...trustedOrigins];
    if (config.allowSameOriginBootstrap && request) {
      try {
        origins.push(new URL(request.url).origin);
      } catch {
        // Ignore malformed request URLs.
      }
    }
    return origins;
  },
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema,
  }),
  plugins: oidcEnabled
    ? [
        genericOAuth({
          config: [
            {
              providerId: "oidc",
              name: config.oidc.name,
              discoveryUrl: config.oidc.discoveryUrl,
              clientId: config.oidc.clientId,
              clientSecret: oidcClientSecret ?? undefined,
              scopes: config.oidc.scopes,
              pkce: true,
              disableSignUp: !config.oidc.autoProvision,
              requireIdTokenVerification: true,
            },
          ],
        }),
      ]
    : [],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: false,
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: oidcEnabled ? config.oidc.defaultRole : "viewer",
        input: false,
      },
    },
    validateUserInfo: async ({ user, source }) => {
      if (source.method !== "oauth" || source.oauth?.providerId !== "oidc") return;
      if (config.oidc.allowedDomains.length === 0) return;
      const email = String(user.email ?? "").trim().toLowerCase();
      const domain = email.split("@")[1] ?? "";
      if (!config.oidc.allowedDomains.includes(domain)) {
        return {
          error: "email_domain_not_allowed",
          errorDescription: "This email domain is not allowed for single sign-on.",
        };
      }
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: oidcEnabled ? ["oidc"] : [],
      requireLocalEmailVerified: false,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },
});

export async function seedAdminFromEnvironment() {
  const rows = db.select({ count: sql<number>`count(*)` }).from(schema.user).all();
  const count = Number(rows[0]?.count ?? 0);
  if (count > 0) return;

  if (!config.adminEmail || !config.adminPassword) {
    console.warn("[cetus] no users exist; set CETUS_ADMIN_EMAIL and CETUS_ADMIN_PASSWORD to seed the first admin.");
    return;
  }

  await auth.api.signUpEmail({
    body: {
      email: config.adminEmail,
      password: config.adminPassword,
      name: "Cetus Admin",
    },
  });
  db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.email, config.adminEmail)).run();
}
