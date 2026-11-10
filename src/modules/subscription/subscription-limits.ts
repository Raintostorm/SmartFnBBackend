/**
 * Pure v17.1 subscription arithmetic (13.1, 31.2, BR-91, BR-92). No I/O so the same rules back the
 * invoice preview, the invoice job, next-period registration and quota enforcement.
 */
export const ACCOUNT_PACK_SIZE = 5;
export const MAX_ACCOUNT_PACKS = 4;
export const MAX_TOTAL_BRANCHES = 10;

type Money = number | { toString(): string };

export interface PlanPricing {
  id: string;
  code: string;
  name: string;
  monthlyPrice: Money;
  maxBranches: number;
  maxAccounts: number;
  extraBranchPrice: number;
  extraBranchAccounts: number;
  extraAccountPackPrice: number;
  extraBranchEnabled: boolean;
  isActive?: boolean;
}

export interface Selection {
  extraBranches: number;
  accountPacks: number;
}

export const toVnd = (value: Money) => Math.round(Number(value.toString()));

export const isPaidPlan = (plan: Pick<PlanPricing, 'code' | 'monthlyPrice'>) =>
  plan.code !== 'TRIAL' && toVnd(plan.monthlyPrice) > 0;

export function computeLimits(plan: PlanPricing, selection: Selection) {
  return {
    branchLimit: plan.maxBranches + selection.extraBranches,
    accountLimit:
      plan.maxAccounts +
      selection.extraBranches * plan.extraBranchAccounts +
      selection.accountPacks * ACCOUNT_PACK_SIZE,
  };
}

export function selectionTotal(plan: PlanPricing, selection: Selection) {
  return (
    toVnd(plan.monthlyPrice) +
    selection.extraBranches * plan.extraBranchPrice +
    selection.accountPacks * plan.extraAccountPackPrice
  );
}

/** Invoice lines frozen at the moment they are computed (BR-72). */
export function invoiceLines(plan: PlanPricing, selection: Selection) {
  const unit = toVnd(plan.monthlyPrice);
  return [
    { kind: 'PLAN', description: `Gói ${plan.name}`, quantity: 1, unitPrice: unit, amount: unit },
    ...(selection.extraBranches
      ? [
          {
            kind: 'EXTRA_BRANCH',
            description: `Thêm chi nhánh (kèm ${plan.extraBranchAccounts} tài khoản)`,
            quantity: selection.extraBranches,
            unitPrice: plan.extraBranchPrice,
            amount: selection.extraBranches * plan.extraBranchPrice,
          },
        ]
      : []),
    ...(selection.accountPacks
      ? [
          {
            kind: 'ACCOUNT_PACK',
            description: `Thêm ${ACCOUNT_PACK_SIZE} tài khoản`,
            quantity: selection.accountPacks,
            unitPrice: plan.extraAccountPackPrice,
            amount: selection.accountPacks * plan.extraAccountPackPrice,
          },
        ]
      : []),
  ];
}

export type AddonViolation =
  | { error: 'INVALID_ADDON_QUANTITY'; message: string }
  | { error: 'ADDON_NOT_SOLD'; message: string }
  | { error: 'MAX_BRANCHES_EXCEEDED'; message: string; maxTotalBranches: number }
  | {
      error: 'ADDON_UPGRADE_BETTER';
      message: string;
      suggestedPlan: { id: string; code: string; name: string; monthlyPrice: number; maxBranches: number };
      selectionTotal: number;
    };

/**
 * The cheapest active paid plan, other than `plan`, with enough branches for `branchesNeeded`.
 * BR-92 compares against this plan.
 */
export function cheapestPlanWithBranches(
  plan: PlanPricing,
  catalog: PlanPricing[],
  branchesNeeded: number,
) {
  return catalog
    .filter(
      (candidate) =>
        candidate.id !== plan.id &&
        candidate.isActive !== false &&
        isPaidPlan(candidate) &&
        candidate.maxBranches >= branchesNeeded,
    )
    .sort((a, b) => toVnd(a.monthlyPrice) - toVnd(b.monthlyPrice) || a.maxBranches - b.maxBranches)[0];
}

/** BR-91/BR-92 validation of a next-period add-on selection; `null` when it may be sold. */
export function addonViolation(
  plan: PlanPricing,
  selection: Selection,
  catalog: PlanPricing[],
): AddonViolation | null {
  const { extraBranches, accountPacks } = selection;
  if (
    !Number.isInteger(extraBranches) ||
    extraBranches < 0 ||
    !Number.isInteger(accountPacks) ||
    accountPacks < 0 ||
    accountPacks > MAX_ACCOUNT_PACKS
  ) {
    return {
      error: 'INVALID_ADDON_QUANTITY',
      message: `Số chi nhánh mua thêm phải ≥ 0 và tối đa ${MAX_ACCOUNT_PACKS} gói tài khoản mỗi kỳ.`,
    };
  }
  if ((extraBranches || accountPacks) && !isPaidPlan(plan)) {
    return { error: 'ADDON_NOT_SOLD', message: 'Gói dùng thử hoặc gói miễn phí không có mua thêm.' };
  }
  if (accountPacks && plan.extraAccountPackPrice <= 0) {
    return { error: 'ADDON_NOT_SOLD', message: `Gói ${plan.name} không bán gói tài khoản.` };
  }
  if (extraBranches && (!plan.extraBranchEnabled || plan.extraBranchPrice <= 0)) {
    return { error: 'ADDON_NOT_SOLD', message: `Gói ${plan.name} không bán thêm chi nhánh.` };
  }
  if (plan.maxBranches + extraBranches > MAX_TOTAL_BRANCHES) {
    return {
      error: 'MAX_BRANCHES_EXCEEDED',
      message: `Tổng số chi nhánh không vượt quá ${MAX_TOTAL_BRANCHES}.`,
      maxTotalBranches: MAX_TOTAL_BRANCHES,
    };
  }
  if (extraBranches) {
    const better = cheapestPlanWithBranches(plan, catalog, plan.maxBranches + extraBranches);
    const total = toVnd(plan.monthlyPrice) + extraBranches * plan.extraBranchPrice;
    if (better && total >= toVnd(better.monthlyPrice)) {
      return {
        error: 'ADDON_UPGRADE_BETTER',
        message: `Gói ${plan.name} + ${extraBranches} chi nhánh là ${total.toLocaleString('vi-VN')}đ, bằng hoặc cao hơn gói ${better.name} (${toVnd(better.monthlyPrice).toLocaleString('vi-VN')}đ). Hãy nâng lên gói ${better.name}.`,
        suggestedPlan: {
          id: better.id,
          code: better.code,
          name: better.name,
          monthlyPrice: toVnd(better.monthlyPrice),
          maxBranches: better.maxBranches,
        },
        selectionTotal: total,
      };
    }
  }
  return null;
}

/** Largest number of extra branches the plan may sell under BR-91/BR-92. */
export function maxSellableExtraBranches(plan: PlanPricing, catalog: PlanPricing[]) {
  let allowed = 0;
  for (let n = 1; plan.maxBranches + n <= MAX_TOTAL_BRANCHES; n++) {
    if (addonViolation(plan, { extraBranches: n, accountPacks: 0 }, catalog)) break;
    allowed = n;
  }
  return allowed;
}

/**
 * Carries the add-ons over when the next plan changes (31.5): an upgrade that already covers the
 * branch count drops extra branches; a downgrade re-prices them at the new plan and trims them
 * until BR-92 holds. Account packs stay as they are (still capped to the plan's offer).
 */
export function carryOverAddons(
  fromPlan: PlanPricing,
  from: Selection,
  toPlan: PlanPricing,
  catalog: PlanPricing[],
) {
  const warnings: string[] = [];
  let extraBranches = from.extraBranches;
  if (toPlan.id !== fromPlan.id && toPlan.maxBranches >= fromPlan.maxBranches + from.extraBranches) {
    if (extraBranches) warnings.push('Chi nhánh mua thêm được bỏ ở kỳ tới vì gói mới đã đủ số chi nhánh.');
    extraBranches = 0;
  }
  const allowed = maxSellableExtraBranches(toPlan, catalog);
  if (extraBranches > allowed) {
    warnings.push(
      `Gói ${toPlan.name} chỉ cho mua thêm tối đa ${allowed} chi nhánh; phần mua thêm được bớt cho vừa (BR-92).`,
    );
    extraBranches = allowed;
  }
  let accountPacks = Math.min(from.accountPacks, MAX_ACCOUNT_PACKS);
  if (accountPacks && (!isPaidPlan(toPlan) || toPlan.extraAccountPackPrice <= 0)) {
    warnings.push(`Gói ${toPlan.name} không bán gói tài khoản; phần này được bỏ.`);
    accountPacks = 0;
  }
  return { selection: { extraBranches, accountPacks }, warnings };
}
