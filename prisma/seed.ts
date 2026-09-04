import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required to seed the database.');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const roles = [
  ['SUPER_ADMIN', 'Super Admin', 'Quản trị toàn bộ hệ thống'],
  ['CHAIN_ADMIN', 'Chain Admin', 'Quản trị chuỗi nhà hàng'],
  ['BRANCH_MANAGER', 'Branch Manager', 'Quản lý một chi nhánh'],
  ['WAITER', 'Waiter', 'Nhân viên phục vụ'],
  ['KITCHEN', 'Kitchen', 'Nhân viên bếp'],
  ['BAR', 'Bar', 'Nhân viên quầy bar'],
  ['CASHIER', 'Cashier', 'Nhân viên thu ngân'],
  ['CUSTOMER', 'Customer', 'Khách hàng'],
] as const;

async function main(): Promise<void> {
  await Promise.all(
    roles.map(([code, name, description]) =>
      prisma.role.upsert({
        where: { code },
        update: { name, description },
        create: { code, name, description, isSystem: true },
      }),
    ),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
