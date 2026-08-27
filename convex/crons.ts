import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Hosted Checkout webhooks stay on the Vitality merchant URL, so Rekindle confirms
// payment by polling Clover for the orderRef we stamped on the line item.
crons.interval(
  "confirm pending clover payments",
  { minutes: 2 },
  internal.enrollments.confirmPendingSweep,
);

// EasyPay monthly rebills. Hard-stopped at $600 / 12 payments. test_mode rows never enter this.
crons.daily(
  "rekindle easypay rebills",
  { hourUTC: 15, minuteUTC: 0 },
  internal.enrollments.runBilling,
);

export default crons;
