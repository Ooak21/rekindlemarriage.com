// Rekindle owns its own identity now. One provider, this deployment's own JWKS.
// No shared issuer, no other product's users, no inherited redirect rules.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
