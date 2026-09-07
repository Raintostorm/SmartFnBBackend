export enum AppRole {
  ADMIN = 'ADMIN',
  WAITER = 'WAITER',
  KITCHEN = 'KITCHEN',
  CASHIER = 'CASHIER',
  CUSTOMER = 'CUSTOMER',
}

export const STAFF_ROLES = [AppRole.WAITER, AppRole.KITCHEN, AppRole.CASHIER] as const;

export function isAppRole(value: string): value is AppRole {
  return Object.values(AppRole).includes(value as AppRole);
}
