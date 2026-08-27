export const TOTAL_CENTS = 60000;
export const EASYPAY_CENTS = 5000;
export const PIF_CENTS = 60000;
export const EASYPAY_CAP = 12;
export const TEST_CENTS = 100;

export function specForPlan(plan: string, testMode: boolean) {
  if (plan === "easypay") {
    return {
      amountCents: testMode ? TEST_CENTS : EASYPAY_CENTS,
      totalCents: TOTAL_CENTS,
      cap: EASYPAY_CAP,
      itemName: "Rekindle EasyPay Plan — first payment",
    };
  }
  if (plan === "pay_in_full") {
    return {
      amountCents: testMode ? TEST_CENTS : PIF_CENTS,
      totalCents: TOTAL_CENTS,
      cap: 1,
      itemName: "Rekindle Marriage Workshop — Pay in Full",
    };
  }
  return null;
}
