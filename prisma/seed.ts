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
  ['OWNER', 'Owner', 'Chủ sở hữu quản lý các chuỗi nhà hàng được phân công'],
  ['MANAGER', 'Manager', 'Quản lý một chi nhánh được phân công'],
  ['WAITER', 'Waiter', 'Nhân viên phục vụ'],
  ['KITCHEN', 'Kitchen Staff', 'Nhân viên bếp'],
  ['CASHIER', 'Cashier', 'Nhân viên thu ngân'],
] as const;

const legacyRoleCodes = [
  'SUPER_ADMIN',
  'CHAIN_ADMIN',
  'BRANCH_MANAGER',
  'BAR',
  'CUSTOMER',
] as const;

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

  if (process.env.SEED_DEMO_DATA === 'true') {
    await createDemoOperationsData();
  }
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

async function createDemoOperationsData(): Promise<void> {
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password) {
    throw new Error('SEED_DEMO_PASSWORD is required when SEED_DEMO_DATA=true.');
  }
  validateSeedPassword(password, 'SEED_DEMO_PASSWORD');

  const ids = {
    chain: '10000000-0000-4000-8000-000000000001',
    branch: '10000000-0000-4000-8000-000000000002',
    waiterUser: '10000000-0000-4000-8000-000000000003',
    waiter: '10000000-0000-4000-8000-000000000004',
    kitchenUser: '10000000-0000-4000-8000-000000000005',
    kitchen: '10000000-0000-4000-8000-000000000006',
    waiterWorkSession: '10000000-0000-4000-8000-000000000007',
    kitchenWorkSession: '10000000-0000-4000-8000-000000000008',
    diningArea: '10000000-0000-4000-8000-000000000009',
    kitchenArea: '10000000-0000-4000-8000-000000000010',
    table1: '10000000-0000-4000-8000-000000000011',
    table2: '10000000-0000-4000-8000-000000000012',
    table3: '10000000-0000-4000-8000-000000000013',
    table4: '10000000-0000-4000-8000-000000000014',
    adjacency12: '10000000-0000-4000-8000-000000000015',
    adjacency23: '10000000-0000-4000-8000-000000000016',
    adjacency34: '10000000-0000-4000-8000-000000000017',
    category: '10000000-0000-4000-8000-000000000018',
    itemRice: '10000000-0000-4000-8000-000000000019',
    itemSoup: '10000000-0000-4000-8000-000000000020',
    itemDrink: '10000000-0000-4000-8000-000000000021',
    tableSession: '10000000-0000-4000-8000-000000000022',
    order: '10000000-0000-4000-8000-000000000023',
    readyItem: '10000000-0000-4000-8000-000000000024',
    preparingItem: '10000000-0000-4000-8000-000000000025',
    servingTask: '10000000-0000-4000-8000-000000000026',
    payment: '10000000-0000-4000-8000-000000000027',
    servicePlan: '10000000-0000-4000-8000-000000000028',
    subscription: '10000000-0000-4000-8000-000000000029',
    branding: '10000000-0000-4000-8000-000000000030',
    wallet: '10000000-0000-4000-8000-000000000031',
  } as const;

  const [waiterRole, kitchenRole] = await Promise.all([
    prisma.role.findUniqueOrThrow({ where: { code: 'WAITER' } }),
    prisma.role.findUniqueOrThrow({ where: { code: 'KITCHEN' } }),
  ]);
  const passwordHash = await hash(password, {
    type: argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  await prisma.restaurantChain.upsert({
    where: { id: ids.chain },
    update: { name: 'Smart F&B Demo Chain', status: 'ACTIVE' },
    create: {
      id: ids.chain,
      code: 'SMART_FNB_DEMO',
      name: 'Smart F&B Demo Chain',
    },
  });

  const demoPlan = await prisma.servicePlan.upsert({
    where: { code: 'DEMO_OPERATIONS' },
    update: {
      name: 'Demo Operations',
      description: 'Gói dữ liệu mẫu phục vụ kiểm thử các luồng vận hành',
      monthlyPrice: 0,
      maxBranches: 5,
      maxAccounts: 20,
      maxTables: 100,
      isActive: true,
    },
    create: {
      id: ids.servicePlan,
      code: 'DEMO_OPERATIONS',
      name: 'Demo Operations',
      description: 'Gói dữ liệu mẫu phục vụ kiểm thử các luồng vận hành',
      monthlyPrice: 0,
      maxBranches: 5,
      maxAccounts: 20,
      maxTables: 100,
    },
  });

  await Promise.all([
    prisma.businessSubscription.upsert({
      where: { chainId: ids.chain },
      update: {
        planId: demoPlan.id,
        status: 'ACTIVE',
        monthlyPrice: 0,
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2099-12-31T23:59:59.999Z'),
        suspendedAt: null,
      },
      create: {
        id: ids.subscription,
        chainId: ids.chain,
        planId: demoPlan.id,
        status: 'ACTIVE',
        monthlyPrice: 0,
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2099-12-31T23:59:59.999Z'),
      },
    }),
    prisma.businessBranding.upsert({
      where: { chainId: ids.chain },
      update: { displayName: 'Smart F&B Demo Chain' },
      create: {
        id: ids.branding,
        chainId: ids.chain,
        displayName: 'Smart F&B Demo Chain',
      },
    }),
    prisma.businessWallet.upsert({
      where: { chainId: ids.chain },
      update: { currency: 'VND', status: 'ACTIVE' },
      create: {
        id: ids.wallet,
        chainId: ids.chain,
        currency: 'VND',
      },
    }),
  ]);

  await prisma.branch.upsert({
    where: { id: ids.branch },
    update: { name: 'Smart F&B Nguyễn Huệ', status: 'ACTIVE' },
    create: {
      id: ids.branch,
      chainId: ids.chain,
      code: 'HCM_NGUYEN_HUE',
      name: 'Smart F&B Nguyễn Huệ',
      addressLine1: '01 Nguyễn Huệ',
      district: 'Quận 1',
      city: 'Hồ Chí Minh',
    },
  });

  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
    await prisma.branchOperatingHour.upsert({
      where: { branchId_dayOfWeek: { branchId: ids.branch, dayOfWeek } },
      update: { openTime: '09:00', closeTime: '22:00', isClosed: false },
      create: {
        branchId: ids.branch,
        dayOfWeek,
        openTime: '09:00',
        closeTime: '22:00',
      },
    });
  }

  await Promise.all([
    prisma.branchArea.upsert({
      where: { id: ids.diningArea },
      update: { name: 'Khu phục vụ tầng 1', status: 'ACTIVE' },
      create: {
        id: ids.diningArea,
        branchId: ids.branch,
        code: 'DINING_F1',
        name: 'Khu phục vụ tầng 1',
        type: 'DINING',
      },
    }),
    prisma.branchArea.upsert({
      where: { id: ids.kitchenArea },
      update: { name: 'Bếp chính', status: 'ACTIVE' },
      create: {
        id: ids.kitchenArea,
        branchId: ids.branch,
        code: 'KITCHEN_MAIN',
        name: 'Bếp chính',
        type: 'KITCHEN',
      },
    }),
  ]);

  await upsertDemoEmployee({
    userId: ids.waiterUser,
    employeeId: ids.waiter,
    email: 'waiter.demo@smartfnb.local',
    employeeCode: 'DEMO-WAITER-01',
    firstName: 'Bảo',
    lastName: 'Phục vụ',
    jobTitle: 'Waiter',
    roleId: waiterRole.id,
    branchId: ids.branch,
    passwordHash,
  });
  await upsertDemoEmployee({
    userId: ids.kitchenUser,
    employeeId: ids.kitchen,
    email: 'kitchen.demo@smartfnb.local',
    employeeCode: 'DEMO-KITCHEN-01',
    firstName: 'An',
    lastName: 'Nhà bếp',
    jobTitle: 'Kitchen Staff',
    roleId: kitchenRole.id,
    branchId: ids.branch,
    passwordHash,
  });

  const checkedInAt = new Date('2026-09-18T01:00:00.000Z');
  await Promise.all([
    prisma.workSession.upsert({
      where: { id: ids.waiterWorkSession },
      update: { status: 'ACTIVE', checkedInAt, checkedOutAt: null },
      create: {
        id: ids.waiterWorkSession,
        employeeId: ids.waiter,
        branchId: ids.branch,
        status: 'ACTIVE',
        checkedInAt,
        isUnscheduled: true,
        note: 'Ca demo cho Waiter',
      },
    }),
    prisma.workSession.upsert({
      where: { id: ids.kitchenWorkSession },
      update: { status: 'ACTIVE', checkedInAt, checkedOutAt: null },
      create: {
        id: ids.kitchenWorkSession,
        employeeId: ids.kitchen,
        branchId: ids.branch,
        status: 'ACTIVE',
        checkedInAt,
        isUnscheduled: true,
        note: 'Ca demo cho Kitchen Staff',
      },
    }),
  ]);

  const tables = [
    [ids.table1, 'T01', 2, 10, 10, 'OCCUPIED'],
    [ids.table2, 'T02', 2, 30, 10, 'AVAILABLE'],
    [ids.table3, 'T03', 4, 50, 10, 'AVAILABLE'],
    [ids.table4, 'T04', 4, 70, 10, 'AVAILABLE'],
  ] as const;
  for (const [id, code, capacity, positionX, positionY, status] of tables) {
    await prisma.restaurantTable.upsert({
      where: { id },
      update: { capacity, positionX, positionY, status },
      create: {
        id,
        branchId: ids.branch,
        code,
        name: `Bàn ${code.slice(1)}`,
        area: 'Khu phục vụ tầng 1',
        capacity,
        positionX,
        positionY,
        width: 16,
        height: 16,
        status,
      },
    });
  }

  for (const [id, tableId, adjacentTableId] of [
    [ids.adjacency12, ids.table1, ids.table2],
    [ids.adjacency23, ids.table2, ids.table3],
    [ids.adjacency34, ids.table3, ids.table4],
  ] as const) {
    await prisma.tableAdjacency.upsert({
      where: { id },
      update: { tableId, adjacentTableId },
      create: { id, branchId: ids.branch, tableId, adjacentTableId },
    });
  }

  await prisma.menuCategory.upsert({
    where: { id: ids.category },
    update: { name: 'Món chính', isActive: true },
    create: { id: ids.category, branchId: ids.branch, name: 'Món chính' },
  });
  const menuItems = [
    [ids.itemRice, 'DEMO-RICE', 'Cơm gà nướng', 65000, 15, true],
    [ids.itemSoup, 'DEMO-SOUP', 'Canh chua cá', 75000, 8, true],
    [ids.itemDrink, 'DEMO-DRINK', 'Trà đào', 35000, 0, false],
  ] as const;
  for (const [id, sku, name, price, remainingPortions, isAvailable] of menuItems) {
    await prisma.menuItem.upsert({
      where: { id },
      update: { name, price, isAvailable: true, isActive: true },
      create: { id, categoryId: ids.category, sku, name, price },
    });
    await prisma.branchMenuItem.upsert({
      where: { branchId_menuItemId: { branchId: ids.branch, menuItemId: id } },
      update: { isAvailable, remainingPortions, updatedById: ids.kitchen },
      create: {
        branchId: ids.branch,
        menuItemId: id,
        isAvailable,
        remainingPortions,
        updatedById: ids.kitchen,
      },
    });
  }

  await prisma.tableSession.upsert({
    where: { id: ids.tableSession },
    update: { status: 'SERVING', guestCount: 2 },
    create: {
      id: ids.tableSession,
      sessionCode: 'DEMO-SESSION-001',
      branchId: ids.branch,
      openedByWaiterId: ids.waiter,
      guestCount: 2,
      status: 'SERVING',
      guestName: 'Khách demo',
      note: 'Phiên bàn mẫu để kiểm tra database',
    },
  });
  await prisma.tableSessionTable.upsert({
    where: { tableSessionId_tableId: { tableSessionId: ids.tableSession, tableId: ids.table1 } },
    update: { releasedAt: null },
    create: { tableSessionId: ids.tableSession, tableId: ids.table1 },
  });
  await prisma.order.upsert({
    where: { id: ids.order },
    update: { status: 'PREPARING', subtotal: 205000, totalAmount: 205000 },
    create: {
      id: ids.order,
      orderCode: 'DEMO-ORDER-001',
      branchId: ids.branch,
      tableId: ids.table1,
      tableSessionId: ids.tableSession,
      waiterId: ids.waiter,
      createdByWaiterId: ids.waiter,
      status: 'PREPARING',
      subtotal: 205000,
      totalAmount: 205000,
      submittedAt: new Date('2026-09-18T01:15:00.000Z'),
      note: 'Order mẫu gồm món đã sẵn sàng và món đang chế biến',
    },
  });
  await prisma.orderItem.upsert({
    where: { id: ids.readyItem },
    update: { status: 'READY' },
    create: {
      id: ids.readyItem,
      orderId: ids.order,
      menuItemId: ids.itemRice,
      itemName: 'Cơm gà nướng',
      unitPrice: 65000,
      quantity: 2,
      totalPrice: 130000,
      specialInstructions: 'Một phần không hành',
      status: 'READY',
      queuedAt: new Date('2026-09-18T01:15:00.000Z'),
      startedAt: new Date('2026-09-18T01:16:00.000Z'),
      readyAt: new Date('2026-09-18T01:25:00.000Z'),
      completedAt: new Date('2026-09-18T01:25:00.000Z'),
    },
  });
  await prisma.orderItem.upsert({
    where: { id: ids.preparingItem },
    update: { status: 'PREPARING' },
    create: {
      id: ids.preparingItem,
      orderId: ids.order,
      menuItemId: ids.itemSoup,
      itemName: 'Canh chua cá',
      unitPrice: 75000,
      quantity: 1,
      totalPrice: 75000,
      status: 'PREPARING',
      queuedAt: new Date('2026-09-18T01:15:00.000Z'),
      startedAt: new Date('2026-09-18T01:18:00.000Z'),
    },
  });
  await prisma.servingTask.upsert({
    where: { id: ids.servingTask },
    update: { status: 'WAITING', claimedByWaiterId: null, servedByWaiterId: null },
    create: {
      id: ids.servingTask,
      orderItemId: ids.readyItem,
      branchId: ids.branch,
      status: 'WAITING',
      availableAt: new Date('2026-09-18T01:25:00.000Z'),
    },
  });
  await prisma.payment.upsert({
    where: { id: ids.payment },
    update: { status: 'PENDING', amount: 205000 },
    create: {
      id: ids.payment,
      paymentCode: 'DEMO-PAYMENT-001',
      tableSessionId: ids.tableSession,
      method: 'CASH',
      status: 'PENDING',
      amount: 205000,
      note: 'Thanh toán mẫu đang chờ thu ngân xác nhận',
    },
  });

  console.info('Demo operations data seeded.');
  console.info('Waiter: waiter.demo@smartfnb.local');
  console.info('Kitchen Staff: kitchen.demo@smartfnb.local');
}

async function upsertDemoEmployee(input: {
  userId: string;
  employeeId: string;
  email: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  roleId: string;
  branchId: string;
  passwordHash: string;
}): Promise<void> {
  await prisma.user.upsert({
    where: { id: input.userId },
    update: { email: input.email, passwordHash: input.passwordHash, roleId: input.roleId },
    create: {
      id: input.userId,
      email: input.email,
      passwordHash: input.passwordHash,
      roleId: input.roleId,
    },
  });
  await prisma.employee.upsert({
    where: { id: input.employeeId },
    update: {
      branchId: input.branchId,
      firstName: input.firstName,
      lastName: input.lastName,
      jobTitle: input.jobTitle,
      status: 'ACTIVE',
    },
    create: {
      id: input.employeeId,
      userId: input.userId,
      branchId: input.branchId,
      employeeCode: input.employeeCode,
      firstName: input.firstName,
      lastName: input.lastName,
      jobTitle: input.jobTitle,
    },
  });
}

function validateSeedPassword(password: string, variableName: string): void {
  if (
    password.length < 12 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    throw new Error(
      `${variableName} must be at least 12 characters and contain uppercase, lowercase, and numeric characters.`,
    );
  }
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
