/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as crm from "../crm.js";
import type * as emberPrompt from "../emberPrompt.js";
import type * as http from "../http.js";
import type * as mailer from "../mailer.js";
import type * as migrate from "../migrate.js";
import type * as passwordReset from "../passwordReset.js";
import type * as provision from "../provision.js";
import type * as receptionist from "../receptionist.js";
import type * as reserve from "../reserve.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  crm: typeof crm;
  emberPrompt: typeof emberPrompt;
  http: typeof http;
  mailer: typeof mailer;
  migrate: typeof migrate;
  passwordReset: typeof passwordReset;
  provision: typeof provision;
  receptionist: typeof receptionist;
  reserve: typeof reserve;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
