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
    ownerUser: '10000000-0000-4000-8000-000000000032',
    owner: '10000000-0000-4000-8000-000000000033',
    ownerAssignment: '10000000-0000-4000-8000-000000000034',
    managerUser: '10000000-0000-4000-8000-000000000035',
    manager: '10000000-0000-4000-8000-000000000036',
    shiftTemplate: '10000000-0000-4000-8000-000000000037',
    waiterShiftAssignment: '10000000-0000-4000-8000-000000000038',
    reservation: '10000000-0000-4000-8000-000000000039',
  } as const;

  const [waiterRole, kitchenRole, ownerRole, managerRole] = await Promise.all([
    prisma.role.findUniqueOrThrow({ where: { code: 'WAITER' } }),
    prisma.role.findUniqueOrThrow({ where: { code: 'KITCHEN' } }),
    prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } }),
    prisma.role.findUniqueOrThrow({ where: { code: 'MANAGER' } }),
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

  const workDate = new Date();
  workDate.setUTCHours(0, 0, 0, 0);
  const shiftTemplate = await prisma.shiftTemplate.upsert({
    where: { id: ids.shiftTemplate },
    update: { name: 'Ca sáng demo', startTime: '08:00', endTime: '16:00', isActive: true },
    create: {
      id: ids.shiftTemplate,
      branchId: ids.branch,
      name: 'Ca sáng demo',
      startTime: '08:00',
      endTime: '16:00',
    },
  });
  const waiterShiftAssignment = await prisma.shiftAssignment.upsert({
    where: { id: ids.waiterShiftAssignment },
    update: {
      workDate,
      scheduledStart: new Date(workDate.getTime() + 60 * 60_000),
      scheduledEnd: new Date(workDate.getTime() + 9 * 60 * 60_000),
      status: 'SCHEDULED',
    },
    create: {
      id: ids.waiterShiftAssignment,
      branchId: ids.branch,
      employeeId: ids.waiter,
      shiftTemplateId: shiftTemplate.id,
      workDate,
      scheduledStart: new Date(workDate.getTime() + 60 * 60_000),
      scheduledEnd: new Date(workDate.getTime() + 9 * 60 * 60_000),
    },
  });
  await prisma.user.upsert({
    where: { id: ids.ownerUser },
    update: {
      email: 'owner.demo@smartfnb.local',
      passwordHash,
      roleId: ownerRole.id,
      status: 'ACTIVE',
    },
    create: {
      id: ids.ownerUser,
      email: 'owner.demo@smartfnb.local',
      passwordHash,
      roleId: ownerRole.id,
    },
  });
  await prisma.owner.upsert({
    where: { id: ids.owner },
    update: { firstName: 'Bảo', lastName: 'Chủ chuỗi', deletedAt: null },
    create: {
      id: ids.owner,
      userId: ids.ownerUser,
      ownerCode: 'DEMO-OWNER-01',
      firstName: 'Bảo',
      lastName: 'Chủ chuỗi',
    },
  });
  await prisma.ownerChainAssignment.upsert({
    where: { id: ids.ownerAssignment },
    update: { ownerId: ids.owner, chainId: ids.chain },
    create: { id: ids.ownerAssignment, ownerId: ids.owner, chainId: ids.chain },
  });
  await upsertDemoEmployee({
    userId: ids.managerUser,
    employeeId: ids.manager,
    email: 'manager.demo@smartfnb.local',
    employeeCode: 'DEMO-MANAGER-01',
    firstName: 'Minh',
    lastName: 'Quản lý',
    jobTitle: 'Branch Manager',
    roleId: managerRole.id,
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
      update: {
        status: 'ACTIVE',
        checkedInAt,
        checkedOutAt: null,
        shiftAssignmentId: waiterShiftAssignment.id,
        isUnscheduled: false,
      },
      create: {
        id: ids.waiterWorkSession,
        employeeId: ids.waiter,
        branchId: ids.branch,
        status: 'ACTIVE',
        shiftAssignmentId: waiterShiftAssignment.id,
        checkedInAt,
        isUnscheduled: false,
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

  const reservationAt = new Date(Date.now() + 24 * 60 * 60_000);
  reservationAt.setMinutes(0, 0, 0);
  await prisma.reservation.upsert({
    where: { id: ids.reservation },
    update: {
      reservationAt,
      status: 'CONFIRMED',
      tableId: ids.table3,
      confirmedById: ids.manager,
      confirmedAt: new Date(),
    },
    create: {
      id: ids.reservation,
      reservationCode: 'DEMO-RESERVATION-001',
      branchId: ids.branch,
      tableId: ids.table3,
      confirmedById: ids.manager,
      createdById: ids.manager,
      updatedById: ids.manager,
      guestName: 'Khách đặt bàn demo',
      guestPhone: '0900000000',
      partySize: 6,
      reservationAt,
      durationMinutes: 120,
      status: 'CONFIRMED',
      source: 'PHONE',
      confirmedAt: new Date(),
      note: 'Đặt bàn mẫu dùng hai bàn liền kề T03 và T04',
    },
  });
  for (const tableId of [ids.table3, ids.table4]) {
    await prisma.reservationTable.upsert({
      where: { reservationId_tableId: { reservationId: ids.reservation, tableId } },
      update: { releasedAt: null },
      create: { reservationId: ids.reservation, tableId },
    });
  }

  await prisma.menuCategory.upsert({
    where: { id: ids.category },
    update: { name: 'Món chính', isActive: true },
    create: { id: ids.category, chainId: ids.chain, name: 'Món chính' },
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

  await seedSalesHistory({
    chainId: ids.chain,
    firstBranchId: ids.branch,
    firstWaiterId: ids.waiter,
    menuItemIds: [ids.itemRice, ids.itemSoup, ids.itemDrink],
    passwordHash,
  });

  console.info('Demo operations data seeded.');
  console.info('Waiter: waiter.demo@smartfnb.local');
  console.info('Kitchen Staff: kitchen.demo@smartfnb.local');
  console.info('Owner: owner.demo@smartfnb.local');
  console.info('Manager: manager.demo@smartfnb.local');
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

/**
 * Two weeks of finished sales at two branches, so the Owner comparison reports
 * have something to compare. Everything here is deterministic and re-runnable.
 */
async function seedSalesHistory(input: {
  chainId: string;
  firstBranchId: string;
  firstWaiterId: string;
  menuItemIds: readonly [string, string, string];
  passwordHash: string;
}): Promise<void> {
  const salesId = (offset: number): string =>
    `20000000-0000-4000-8000-${offset.toString().padStart(12, '0')}`;

  const secondBranchId = salesId(1);
  const secondWaiterUserId = salesId(2);
  const secondWaiterId = salesId(3);

  await prisma.branch.upsert({
    where: { id: secondBranchId },
    update: { name: 'Smart F&B Demo - Thảo Điền', status: 'ACTIVE' },
    create: {
      id: secondBranchId,
      chainId: input.chainId,
      code: 'DEMO-THAO-DIEN',
      name: 'Smart F&B Demo - Thảo Điền',
      addressLine1: '12 Nguyễn Văn Hưởng',
      district: 'Thủ Đức',
      city: 'Hồ Chí Minh',
      phone: '+84901234568',
    },
  });
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    await prisma.branchOperatingHour.upsert({
      where: { branchId_dayOfWeek: { branchId: secondBranchId, dayOfWeek } },
      update: { openTime: '09:00', closeTime: '22:00', isClosed: false },
      create: { branchId: secondBranchId, dayOfWeek, openTime: '09:00', closeTime: '22:00' },
    });
  }

  const waiterRole = await prisma.role.findUniqueOrThrow({ where: { code: 'WAITER' } });
  await upsertDemoEmployee({
    userId: secondWaiterUserId,
    employeeId: secondWaiterId,
    email: 'waiter.thaodien@smartfnb.local',
    employeeCode: 'DEMO-WTR-002',
    firstName: 'Bình',
    lastName: 'Trần',
    jobTitle: 'Nhân viên phục vụ',
    roleId: waiterRole.id,
    branchId: secondBranchId,
    passwordHash: input.passwordHash,
  });

  const [riceId, soupId, drinkId] = input.menuItemIds;
  for (const menuItemId of input.menuItemIds) {
    await prisma.branchMenuItem.upsert({
      where: { branchId_menuItemId: { branchId: secondBranchId, menuItemId } },
      update: { isEnabled: true, isAvailable: true },
      create: { branchId: secondBranchId, menuItemId, isEnabled: true, isAvailable: true },
    });
  }

  const lines = [
    { menuItemId: riceId, itemName: 'Cơm gà nướng', unitPrice: 65_000 },
    { menuItemId: soupId, itemName: 'Canh chua cá', unitPrice: 75_000 },
    { menuItemId: drinkId, itemName: 'Trà đào', unitPrice: 35_000 },
  ];
  const branches = [
    { branchId: input.firstBranchId, waiterId: input.firstWaiterId, ordersPerDay: 3, prefix: 'H1' },
    { branchId: secondBranchId, waiterId: secondWaiterId, ordersPerDay: 2, prefix: 'H2' },
  ];

  // Anchored to midnight UTC today so the default 30-day report window covers it.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let sequence = 100;

  for (let daysAgo = 13; daysAgo >= 0; daysAgo -= 1) {
    const day = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);

    for (const branch of branches) {
      for (let index = 0; index < branch.ordersPerDay; index += 1) {
        // 04:00/07:00/10:00 UTC is 11:00/14:00/17:00 in Asia/Ho_Chi_Minh, so every
        // order sits inside local trading hours and inside its own local day.
        const placedAt = new Date(day.getTime() + (4 + index * 3) * 60 * 60 * 1000);
        const sessionId = salesId((sequence += 1));
        const orderId = salesId((sequence += 1));
        const guestCount = 2 + ((daysAgo + index) % 3);
        // A rotating line-up keeps the top-item ranking non-trivial.
        const orderLines = lines.slice(0, 1 + ((daysAgo + index) % lines.length));
        const totalAmount = orderLines.reduce(
          (total, line, lineIndex) => total + line.unitPrice * (1 + (lineIndex % 2)),
          0,
        );

        await prisma.tableSession.upsert({
          where: { id: sessionId },
          update: {
            status: 'CLOSED',
            guestCount,
            openedAt: placedAt,
            paidAt: new Date(placedAt.getTime() + 75 * 60 * 1000),
            closedAt: new Date(placedAt.getTime() + 80 * 60 * 1000),
          },
          create: {
            id: sessionId,
            sessionCode: `DEMO-${branch.prefix}-SESSION-${sequence}`,
            branchId: branch.branchId,
            openedByWaiterId: branch.waiterId,
            closedByWaiterId: branch.waiterId,
            guestCount,
            status: 'CLOSED',
            paymentStatus: 'PAID',
            openedAt: placedAt,
            paidAt: new Date(placedAt.getTime() + 75 * 60 * 1000),
            closedAt: new Date(placedAt.getTime() + 80 * 60 * 1000),
          },
        });

        await prisma.order.upsert({
          where: { id: orderId },
          update: {
            status: 'COMPLETED',
            totalAmount,
            subtotal: totalAmount,
            placedAt,
            submittedAt: placedAt,
            completedAt: new Date(placedAt.getTime() + 70 * 60 * 1000),
          },
          create: {
            id: orderId,
            orderCode: `DEMO-${branch.prefix}-ORDER-${sequence}`,
            branchId: branch.branchId,
            tableSessionId: sessionId,
            waiterId: branch.waiterId,
            createdByWaiterId: branch.waiterId,
            status: 'COMPLETED',
            paymentStatus: 'PAID',
            subtotal: totalAmount,
            totalAmount,
            placedAt,
            submittedAt: placedAt,
            completedAt: new Date(placedAt.getTime() + 70 * 60 * 1000),
          },
        });

        for (const [lineIndex, line] of orderLines.entries()) {
          const quantity = 1 + (lineIndex % 2);
          await prisma.orderItem.upsert({
            where: { id: salesId((sequence += 1)) },
            update: {
              status: 'SERVED',
              quantity,
              totalPrice: line.unitPrice * quantity,
              servedAt: new Date(placedAt.getTime() + 30 * 60 * 1000),
            },
            create: {
              id: salesId(sequence),
              orderId,
              menuItemId: line.menuItemId,
              itemName: line.itemName,
              unitPrice: line.unitPrice,
              quantity,
              totalPrice: line.unitPrice * quantity,
              status: 'SERVED',
              servedByWaiterId: branch.waiterId,
              servedAt: new Date(placedAt.getTime() + 30 * 60 * 1000),
            },
          });
        }

        await prisma.payment.upsert({
          where: { id: salesId((sequence += 1)) },
          update: {
            status: 'SUCCESS',
            amount: totalAmount,
            paidAt: new Date(placedAt.getTime() + 75 * 60 * 1000),
          },
          create: {
            id: salesId(sequence),
            paymentCode: `DEMO-${branch.prefix}-PAY-${sequence}`,
            // payments_exactly_one_payable_check: an order OR a session, never both.
            orderId,
            method: index % 2 === 0 ? 'CASH' : 'BANK_TRANSFER',
            status: 'SUCCESS',
            amount: totalAmount,
            paidAt: new Date(placedAt.getTime() + 75 * 60 * 1000),
          },
        });
      }
    }
  }

  console.info('Sales history seeded for two demo branches over the last 14 days.');
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
