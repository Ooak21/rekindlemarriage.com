"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { createAccount, modifyAccountCredentials } from "@convex-dev/auth/server";

/**
 * Account provisioning. Self-registration is disabled in auth.ts on purpose, so this is the ONLY
 * way an account comes to exist. Internal-only: there is no HTTP route to it, so it cannot be
 * reached from a browser.
 *
 * Run with:
 *   npx convex run provision:createStaff '{"email":"...","password":"...","name":"...","role":"rekindle"}'
 */
export const createStaff = internalAction({
  args: { email: v.string(), password: v.string(), name: v.optional(v.string()), role: v.optional(v.string()) },
  handler: async (ctx, { email, password, name, role }) => {
    const e = email.trim().toLowerCase();
    try {
      const res: any = await createAccount(ctx, {
        provider: "password",
        account: { id: e, secret: password },
        profile: { email: e, name, role: role || "rekindle" } as any,
      });
      return { ok: true as const, userId: res?.user?._id ?? null, email: e };
    } catch (err) {
      return { ok: false as const, email: e, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

/** Set a new password for an existing account, for when someone is locked out. */
export const resetStaffPassword = internalAction({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, { email, password }) => {
    const e = email.trim().toLowerCase();
    try {
      await modifyAccountCredentials(ctx, { provider: "password", account: { id: e, secret: password } });
      return { ok: true as const, email: e };
    } catch (err) {
      return { ok: false as const, email: e, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
