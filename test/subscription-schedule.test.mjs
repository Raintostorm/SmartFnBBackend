import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { SubscriptionScheduleService } from '../dist/modules/subscription/subscription-schedule.service.js';
import { BASIC, chainFake, DAY, STANDARD } from './helpers/subscription-fake.mjs';

const service = (client) => new SubscriptionScheduleService(client, {}, {});

describe('Subscription next period', () => {
  it('freezes a multi-line invoice with the registered add-ons, once', async () => {
    const { client, state } = chainFake({ subscription: { nextExtraBranches: 1, nextAccountPacks: 1, expiresAt: new Date(Date.now() + 5 * DAY) } });
    const preview = await service(client).preview('chain');
    assert.equal(preview.total, 890000);
    assert.equal(preview.branchLimit, 4);
    assert.equal(preview.accountLimit, 43);
    const invoice = await service(client).getOrCreateInvoice('chain');
    assert.equal(invoice.total, 890000);
    assert.deepEqual(invoice.lines.map((line) => line.amount), [590000, 250000, 50000]);
    assert.deepEqual(invoice.lines.map((line) => line.quantity), [1, 1, 1]);
    assert.equal((await service(client).getOrCreateInvoice('chain')).id, invoice.id);
    assert.equal(state.invoices.length, 1);
    assert.equal(state.subscription.planId, 'basic');
  });

  it('keeps an existing registration that a later price change made BR-92-invalid, but reports it', async () => {
    const { client } = chainFake({ subscription: { nextExtraBranches: 2 } });
    const preview = await service(client).preview('chain');
    assert.equal(preview.extraBranches, 2);
    assert.equal(preview.violation.error, 'ADDON_UPGRADE_BETTER');
    assert.equal(preview.violation.suggestedPlan.code, 'STANDARD');
  });

  it('activates a paid future plan only when its period begins', async () => {
    const start = new Date(Date.now() + DAY);
    const { client, state } = chainFake({
      subscription: { pendingPlanId: STANDARD.id, pendingStartsAt: start, pendingExtraBranches: 1, pendingAccountPacks: 2, pendingMonthlyPrice: new Prisma.Decimal(1090000) },
    });
    await service(client).activateDue('chain');
    assert.equal(state.subscription.planId, BASIC.id);
    state.subscription.pendingStartsAt = new Date(Date.now() - 1000);
    await service(client).activateDue('chain');
    assert.equal(state.subscription.planId, STANDARD.id);
    assert.equal(state.subscription.activeExtraBranches, 1);
    assert.equal(state.subscription.activeAccountPacks, 2);
    assert.equal(state.subscription.pendingPlanId, null);
  });

  it('lets a registration made after paying early apply to the period after that one (31.5)', async () => {
    const paidStart = new Date(Date.now() + 2 * DAY);
    const { client, state } = chainFake({
      subscription: { pendingPlanId: STANDARD.id, pendingStartsAt: paidStart, expiresAt: new Date(paidStart.getTime() + 30 * DAY) },
    });
    const preview = await service(client).putNextAddons('chain', 2, 0);
    assert.equal(preview.plan.id, STANDARD.id, 'built on the paid upcoming plan');
    assert.equal(preview.branchLimit, 8);
    assert.equal(new Date(preview.startsAt).getTime(), state.subscription.expiresAt.getTime());
    assert.equal(state.subscription.planId, BASIC.id);
  });
});
