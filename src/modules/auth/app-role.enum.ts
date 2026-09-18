export enum AppRole {
  ADMIN = 'ADMIN',
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  WAITER = 'WAITER',
  KITCHEN = 'KITCHEN',
  CASHIER = 'CASHIER',
}

export const STAFF_ROLES = [
  AppRole.MANAGER,
  AppRole.WAITER,
  AppRole.KITCHEN,
  AppRole.CASHIER,
] as const;

export function isAppRole(value: string): value is AppRole {
  return Object.values(AppRole).includes(value as AppRole);
}
