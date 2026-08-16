import { ConvexError } from "convex/values";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ResendOTPPasswordReset } from "./passwordReset";

// Self-registration is OFF, deliberately. This CRM holds the contact details of couples who came
// to a marriage practice; nobody gets in by signing themselves up. Accounts are provisioned by us.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      reset: ResendOTPPasswordReset,
      profile(params) {
        if (params.flow === "signUp") {
          throw new ConvexError("Self-registration is disabled. Accounts are provisioned by the Rekindle team.");
        }
        return {
          email: params.email as string,
          name: (params.name as string) ?? undefined,
          role: (params.role as string) ?? undefined,
        };
      },
    }),
  ],
});
