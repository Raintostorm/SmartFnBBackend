import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { argon2id, hash } from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required to seed the database.');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const roles = [
  ['ADMIN', 'Admin', 'Quản trị hệ thống và tài khoản nhân viên'],
  ['WAITER', 'Waiter', 'Nhân viên phục vụ'],
  ['KITCHEN', 'Kitchen', 'Nhân viên bếp'],
  ['CASHIER', 'Cashier', 'Nhân viên thu ngân'],
  ['CUSTOMER', 'Customer', 'Khách hàng'],
] as const;

const legacyRoleCodes = ['SUPER_ADMIN', 'CHAIN_ADMIN', 'BRANCH_MANAGER', 'BAR'] as const;

async function main(): Promise<void> {
  for (const [code, name, description] of roles) {
    await prisma.role.upsert({
      where: { code },
      update: { name, description },
      create: { code, name, description, isSystem: true },
    });
  }

  await prisma.role.deleteMany({
    where: {
      code: { in: [...legacyRoleCodes] },
      users: { none: {} },
    },
  });

  await createBootstrapAdmin();
}

async function createBootstrapAdmin(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email && !password) {
    return;
  }

  if (!email || !password) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be provided together.');
  }

  if (
    password.length < 12 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    throw new Error(
      'SEED_ADMIN_PASSWORD must be at least 12 characters and contain uppercase, lowercase, and numeric characters.',
    );
  }

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { role: { select: { code: true } } },
  });

  if (existingUser) {
    if (existingUser.role.code !== 'ADMIN') {
      throw new Error(`Cannot bootstrap ADMIN: ${email} already belongs to another role.`);
    }

    return;
  }

  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { code: 'ADMIN' },
    select: { id: true },
  });
  const passwordHash = await hash(password, {
    type: argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  await prisma.user.create({
    data: {
      email,
      passwordHash,
      roleId: adminRole.id,
    },
  });

  console.info(`Bootstrap ADMIN created: ${email}`);
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
