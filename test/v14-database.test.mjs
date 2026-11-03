import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';
import { PaidOrderRefundService } from '../dist/modules/payments/paid-order-refund.service.js';
import { ManagerReportsService } from '../dist/modules/branch-manager/manager-reports.service.js';
import { MenuExtrasService } from '../dist/modules/menu/menu-extras.service.js';
import { CombosService } from '../dist/modules/menu/combos.service.js';
import { BranchPricesService } from '../dist/modules/menu/branch-prices.js';
import { CounterOperationsService } from '../dist/modules/counter-operations/counter-operations.service.js';
import { PagersService } from '../dist/modules/counter-operations/pagers.service.js';

// Deliberately accepts only the disposable local database documented in the test guide.
const url = process.env.V14_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/postgres@127\.0\.0\.1:55439\/postgres$/.test(url))
  throw new Error('Use the isolated V14 local database on port 55439');
test(
  'V14 PostgreSQL: migration, concurrent pager assignment/refund, and cash drawer',
  { skip: !url },
  async () => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const pool = new Pool({ connectionString: url });
    try {
      const suffix = randomUUID();
      const chain = await prisma.restaurantChain.create({
        data: { code: `test-${suffix}`, name: 'V14 test' },
      });
      const branch = await prisma.branch.create({
        data: {
          chainId: chain.id,
          code: `test-${suffix}`,
          name: 'Test',
          addressLine1: 'Test',
          city: 'Test',
        },
      });
      const role = await prisma.role.upsert({
        where: { code: 'CASHIER' },
        create: { code: 'CASHIER', name: 'Cashier' },
        update: {},
      });
      const user = await prisma.user.create({
        data: {
          email: `${suffix}@example.invalid`,
          passwordHash: 'test-not-a-login-hash',
          roleId: role.id,
        },
      });
      const employee = await prisma.employee.create({
        data: {
          userId: user.id,
          branchId: branch.id,
          employeeCode: `test-${suffix}`,
          firstName: 'Test',
          lastName: 'Cashier',
        },
      });
      const actor = { id: user.id, role: 'CASHIER', branchId: branch.id, employeeId: employee.id };
      const access = {
        assertCanAccessBranch: async () => {},
        assertSubscriptionAllowsWrite: async () => {},
      };
      const realtime = { branch: () => {}, callingDisplay: () => {} };
      const category = await prisma.menuCategory.create({
        data: { chainId: chain.id, name: 'Test' },
      });
      const item = await prisma.menuItem.create({
        data: { categoryId: category.id, sku: suffix, name: 'Tea', price: 30000 },
      });
      const group = await prisma.menuOptionGroup.create({
        data: {
          chainId: chain.id,
          name: 'Topping',
          code: 'TOPPING',
          options: { create: { name: 'Pearl', code: 'PEARL', priceDelta: 5000 } },
          menuItems: { create: { menuItemId: item.id } },
        },
        include: { options: true },
      });
      await prisma.branchMenuOption.create({
        data: { branchId: branch.id, optionId: group.options[0].id, isAvailable: false },
      });
      const conversion = await readFile(
        new URL('../prisma/data-migrations/v14-legacy-toppings.sql', import.meta.url),
        'utf8',
      );
      await pool.query(conversion);
      await pool.query(conversion);
      assert.equal(await prisma.menuExtra.count({ where: { chainId: chain.id } }), 1);
      assert.equal(await prisma.menuItemOptionGroup.count({ where: { menuItemId: item.id } }), 0);
      const link = await prisma.menuItemExtra.findFirstOrThrow({ where: { menuItemId: item.id } });
      assert.equal(link.price.toString(), '5000');
      assert.equal(
        (
          await prisma.branchMenuExtra.findUniqueOrThrow({
            where: { branchId_extraId: { branchId: branch.id, extraId: group.options[0].id } },
          })
        ).isAvailable,
        false,
      );
      const createOrder = () =>
        prisma.order.create({
          data: {
            branchId: branch.id,
            orderCode: randomUUID(),
            type: 'COUNTER_PICKUP',
            status: 'SUBMITTED',
            paymentStatus: 'PAID',
            paidAt: new Date(),
            totalAmount: 30000,
            items: {
              create: {
                menuItemId: item.id,
                itemName: 'Tea',
                unitPrice: 30000,
                quantity: 1,
                totalPrice: 30000,
                status: 'QUEUED',
                units: { create: { sequence: 1, status: 'QUEUED' } },
              },
            },
            payments: {
              create: {
                paymentCode: randomUUID(),
                method: 'BANK_TRANSFER',
                status: 'SUCCESS',
                amount: 30000,
                receivedAmount: 30000,
                paidAt: new Date(),
              },
            },
          },
        });
      const one = await createOrder(),
        two = await createOrder();
      const pagers = new PagersService(prisma, access, realtime);
      const assignment = await Promise.allSettled([
        pagers.change(actor, one.id, 23),
        pagers.change(actor, two.id, 23),
      ]);
      assert.equal(assignment.filter((x) => x.status === 'fulfilled').length, 1);
      const occupied = await prisma.order.findFirstOrThrow({
        where: { branchId: branch.id, pagerNumber: 23 },
      });
      await prisma.order.update({ where: { id: occupied.id }, data: { status: 'COMPLETED' } });
      const other = occupied.id === one.id ? two : one;
      await pagers.change(actor, other.id, 23);
      assert.equal(
        (await prisma.order.findUniqueOrThrow({ where: { id: occupied.id } })).pagerNumber,
        23,
      );
      const refunds = new PaidOrderRefundService(prisma, realtime, access);
      const race = await Promise.allSettled([
        refunds.cashierRefund(actor, other.id, { reasonCode: 'WRONG_ITEM' }),
        refunds.cashierRefund(actor, other.id, { reasonCode: 'WRONG_ITEM' }),
      ]);
      assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(
        await prisma.refund.count({
          where: { orderId: other.id, status: 'COMPLETED', method: 'CASH' },
        }),
        1,
      );
      assert.equal(
        (
          await prisma.orderItemUnit.findFirstOrThrow({
            where: { orderItem: { orderId: other.id } },
          })
        ).status,
        'CANCELLED',
      );
      const report = await new ManagerReportsService(prisma, access).report(
        { ...actor, role: 'MANAGER' },
        { granularity: 'day', limit: 10 },
      );
      const drawer = report.cashDrawer.find((row) => row.employeeId === employee.id);
      assert.equal(drawer.cashCollected, '0');
      assert.equal(Number(drawer.cashRefunded), 30000);
      assert.equal(Number(drawer.netCash), -30000);
      const extraService = new MenuExtrasService(prisma, access, realtime);
      const extraOrder = await createOrder();
      await prisma.orderItem.updateMany({
        where: { orderId: extraOrder.id },
        data: {
          selectedOptions: [
            {
              id: group.options[0].id,
              kind: 'EXTRA',
              name: 'Pearl',
              quantity: 2,
              unitPrice: '5000',
              priceDelta: '10000',
            },
          ],
        },
      });
      await extraService.availability({ ...actor, role: 'BARISTA' }, group.options[0].id, false);
      assert.equal(
        (await prisma.order.findUniqueOrThrow({ where: { id: extraOrder.id } })).attentionReason,
        'EXTRA_OUT_OF_STOCK',
      );
      const lateOrder = await createOrder();
      await prisma.order.update({
        where: { id: lateOrder.id },
        data: { status: 'CANCELLED', paymentStatus: 'UNPAID' },
      });
      const latePayment = await prisma.payment.findFirstOrThrow({
        where: { orderId: lateOrder.id },
      });
      await prisma.payment.update({ where: { id: latePayment.id }, data: { status: 'FAILED' } });
      await refunds.recordLatePayosPayment(latePayment.id, 30000, 'late-test');
      await refunds.recordLatePayosPayment(latePayment.id, 30000, 'late-test');
      assert.equal(await prisma.refund.count({ where: { orderId: lateOrder.id } }), 0);
      await refunds.cancelPaidOrder({ ...actor, role: 'MANAGER' }, lateOrder.id, {
        reason: 'Late payment returned in cash',
        refundMethod: 'CASH',
      });
      assert.equal(
        await prisma.refund.count({
          where: {
            orderId: lateOrder.id,
            status: 'COMPLETED',
            source: 'LATE_PAYMENT',
            method: 'CASH',
          },
        }),
        1,
      );

      // Combo checkout -> payment -> preparation -> whole-parent refund.
      access.assertCanAccessChain = async () => {};
      access.assertCanManageChain = async () => {};
      const owner = { ...actor, role: 'OWNER' };
      const combos = new CombosService(prisma, access, realtime);
      const bread = await prisma.menuItem.create({
        data: { categoryId: category.id, sku: randomUUID(), name: 'Bread', price: 25000 },
      });
      const matcha = await prisma.menuItem.create({
        data: { categoryId: category.id, sku: randomUUID(), name: 'Matcha', price: 35000 },
      });
      for (const id of [item.id, bread.id, matcha.id])
        await prisma.branchMenuItem.create({
          data: { branchId: branch.id, menuItemId: id, remainingPortions: 50 },
        });
      await prisma.menuItemExtra.create({
        data: { menuItemId: matcha.id, extraId: group.options[0].id, price: 5000, maxQuantity: 3 },
      });
      await extraService.availability({ ...actor, role: 'BARISTA' }, group.options[0].id, true);
      const saved = await combos.save(
        chain.id,
        null,
        {
          name: 'Breakfast',
          categoryId: category.id,
          price: 39000,
          components: [
            {
              name: 'Bread',
              type: 'FIXED',
              quantity: 1,
              choices: [{ menuItemId: bread.id, surcharge: 0, isDefault: true }],
            },
            {
              name: 'Drink',
              type: 'CHOICE',
              quantity: 1,
              choices: [
                { menuItemId: item.id, surcharge: 0, isDefault: true },
                { menuItemId: matcha.id, surcharge: 5000, isDefault: false },
              ],
            },
          ],
        },
        owner,
      );
      const branchPrices = new BranchPricesService(prisma, access, realtime);
      await branchPrices.save(
        chain.id,
        {
          updates: [
            { type: 'COMBO', productId: saved.id, branchId: branch.id, priceOverride: 40000 },
            { type: 'ITEM', productId: matcha.id, branchId: branch.id, priceOverride: 90000 },
          ],
        },
        owner,
      );
      const beforePrice = (
        await prisma.branchCombo.findUniqueOrThrow({
          where: { branchId_comboId: { branchId: branch.id, comboId: saved.id } },
        })
      ).priceOverride.toString();
      await assert.rejects(
        branchPrices.save(
          chain.id,
          {
            updates: [
              { type: 'COMBO', productId: saved.id, branchId: branch.id, priceOverride: 1 },
              { type: 'ITEM', productId: item.id, branchId: randomUUID(), priceOverride: 2 },
            ],
          },
          owner,
        ),
      );
      assert.equal(
        (
          await prisma.branchCombo.findUniqueOrThrow({
            where: { branchId_comboId: { branchId: branch.id, comboId: saved.id } },
          })
        ).priceOverride.toString(),
        beforePrice,
      );
      const pos = new CounterOperationsService(
        prisma,
        access,
        { ensureForOrder: async () => null },
        combos,
      );
      const chosen = {
        comboId: saved.id,
        quantity: 2,
        components: [
          {
            componentId: saved.components.find((c) => c.type === 'CHOICE').id,
            menuItemId: matcha.id,
            optionIds: [],
            extras: [{ extraId: group.options[0].id, quantity: 1 }],
          },
        ],
      };
      const order = await pos.checkout(actor, { items: [], combos: [chosen] });
      assert.equal(order.totalAmount.toString(), '100000');
      const root = order.items.find((i) => i.lineType === 'COMBO'),
        children = order.items.filter((i) => i.parentId === root.id);
      assert.equal(children.length, 2);
      assert.equal(
        children.reduce((n, i) => n + i.quantity, 0),
        4,
      );
      assert(
        children.every((i) => i.unitPrice.toString() === '0' && i.totalPrice.toString() === '0'),
      );
      const station = await prisma.posStation.create({
        data: { branchId: branch.id, name: 'Test station' },
      });
      await pos.collectCash(actor, order.id, { stationId: station.id, tenderedAmount: 100000 });
      assert.equal(
        await prisma.orderItemUnit.count({ where: { orderItem: { orderId: order.id } } }),
        4,
      );
      assert.equal(await prisma.orderItemUnit.count({ where: { orderItemId: root.id } }), 0);
      const unitIds = (
        await prisma.orderItemUnit.findMany({ where: { orderItem: { orderId: order.id } } })
      ).map((u) => u.id);
      const barista = { ...actor, role: 'BARISTA' };
      await pos.startBatch(barista, unitIds.slice(0, 2));
      await pos.completeBatch(barista, unitIds.slice(0, 2));
      assert.notEqual(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
        'READY',
      );
      await pos.startBatch(barista, unitIds.slice(2));
      await pos.completeBatch(barista, unitIds.slice(2));
      assert.equal(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
        'READY',
      );
      await assert.rejects(
        refunds.cashierRefund(actor, order.id, {
          reasonCode: 'WRONG_ITEM',
          items: [{ orderItemId: children[0].id }],
        }),
      );
      const beforeRefund = await new ManagerReportsService(prisma, access).report(
        { ...actor, role: 'MANAGER' },
        { granularity: 'day', limit: 100 },
      );
      assert.equal(
        Number(beforeRefund.topCombos.find((c) => c.comboId === saved.id).revenue),
        100000,
      );
      const returned = await refunds.cashierRefund(actor, order.id, {
        reasonCode: 'WRONG_ITEM',
        items: [{ orderItemId: root.id }],
      });
      assert.equal(returned.refund.amount.toString(), '100000');
      assert.equal(returned.refund.items.length, 1);
      assert.equal(
        await prisma.orderItem.count({ where: { orderId: order.id, status: 'CANCELLED' } }),
        3,
      );
      assert.equal(
        await prisma.orderItemUnit.count({
          where: { orderItem: { orderId: order.id }, status: 'CANCELLED' },
        }),
        4,
      );
      // Availability recovers dynamically; no sticky auto-off bit is written on combo.
      await prisma.branchMenuItem.update({
        where: { branchId_menuItemId: { branchId: branch.id, menuItemId: bread.id } },
        data: { isAvailable: false },
      });
      assert.equal(
        (await combos.branchMenu(branch.id)).find((c) => c.comboId === saved.id).effectiveAvailable,
        false,
      );
      await prisma.branchMenuItem.update({
        where: { branchId_menuItemId: { branchId: branch.id, menuItemId: bread.id } },
        data: { isAvailable: true },
      });
      assert.equal(
        (await combos.branchMenu(branch.id)).find((c) => c.comboId === saved.id).effectiveAvailable,
        true,
      );
      await assert.rejects(
        combos.save(
          chain.id,
          null,
          {
            name: 'Foreign choice',
            categoryId: category.id,
            price: 1,
            components: [
              {
                name: 'a',
                type: 'FIXED',
                quantity: 1,
                choices: [{ menuItemId: randomUUID(), surcharge: 0, isDefault: true }],
              },
              {
                name: 'b',
                type: 'FIXED',
                quantity: 1,
                choices: [{ menuItemId: item.id, surcharge: 0, isDefault: true }],
              },
            ],
          },
          owner,
        ),
      );
      console.log(
        'Verified: migrations; idempotent topping conversion; SQL pager uniqueness/release; concurrent refund; QR refund deducted from cash drawer.',
      );
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  },
);
