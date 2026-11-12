export enum AppRole {
  ADMIN = 'ADMIN',
  PLATFORM_STAFF = 'PLATFORM_STAFF',
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  WAITER = 'WAITER',
  KITCHEN = 'KITCHEN',
  CASHIER = 'CASHIER',
  BARISTA = 'BARISTA',
}

export const STAFF_ROLES = [AppRole.MANAGER, AppRole.CASHIER, AppRole.BARISTA] as const;

const ACTIVE_APP_ROLES = [
  AppRole.ADMIN,
  AppRole.PLATFORM_STAFF,
  AppRole.OWNER,
  ...STAFF_ROLES,
] as const;

export function isAppRole(value: string): value is AppRole {
  return (ACTIVE_APP_ROLES as readonly string[]).includes(value);
}
