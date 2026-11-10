import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { PlatformAdminService } from '../dist/modules/platform-admin/platform-admin.service.js';

const basic = { id: 'basic', code: 'BASIC', name: 'Basic', isActive: true, monthlyPrice: new Prisma.Decimal(300000), maxBranches: 2, maxAccounts: 10 };
const trial = { ...basic, id: 'trial', code: 'TRIAL', name: 'Dùng thử 14 ngày', monthlyPrice: new Prisma.Decimal(0) };
const input = { businessName: 'Cafe Test', representativeName: 'Test Owner', representativeEmail: 'owner@example.com', representativePhone: '0900000000' };

function service(prisma) {
  return new PlatformAdminService(prisma, {}, {}, {}, {}, {});
}

it('stores the trial plan selected when submitting an application', async () => {
  let saved;
  const prisma = {
    servicePlan: { findUnique: async () => basic, upsert: async () => trial },
    registrationApplication: { create: async ({ data }) => { saved = data; return data; } },
  };
  await service(prisma).submitRegistrationApplication({ ...input, trialRequested: true });
  assert.equal(saved.requestedPlanId, 'trial');
});

it('stores the paid plan and rejects an empty or conflicting selection', async () => {
  let saved;
  const prisma = {
    servicePlan: { findFirst: async () => basic },
    registrationApplication: { create: async ({ data }) => { saved = data; return data; } },
  };
  const subject = service(prisma);
  await subject.submitRegistrationApplication({ ...input, requestedPlanId: 'basic' });
  assert.equal(saved.requestedPlanId, 'basic');
  await assert.rejects(() => subject.submitRegistrationApplication(input), /Choose trial or a paid plan/);
  await assert.rejects(() => subject.submitRegistrationApplication({ ...input, trialRequested: true, requestedPlanId: 'basic' }), /either trial or a paid plan/);
});

it('does not let approval replace the plan chosen by the applicant', async () => {
  const prisma = { registrationApplication: { findUnique: async () => ({ id: 'application-1', status: 'PENDING', requestedPlanId: 'basic' }) } };
  await assert.rejects(() => service(prisma).approveRegistrationApplication('application-1', { planId: 'other-plan' }, 'admin-1'), /plan selected by the applicant/);
});

it('does not start a PayOS checkout for a trial selection', async () => {
  const prisma = { registrationApplication: { findUnique: async () => ({ id: 'application-1', status: 'APPROVED', requestedPlanId: 'trial', approvedPlan: trial, activationTokenHash: 'token-hash', activationExpiresAt: new Date(Date.now() + 86_400_000) }) } };
  // A real token is hashed before lookup; this stub checks only the approved plan guard.
  await assert.rejects(() => service(prisma).createActivationCheckout('token'), /Approved paid plan is unavailable/);
});

it('does not activate a paid Basic application as a free trial', async () => {
  const prisma = { registrationApplication: { findUnique: async () => ({ id: 'application-1', status: 'APPROVED', requestedPlanId: 'basic', approvedPlan: basic, activationTokenHash: 'token-hash', activationExpiresAt: new Date(Date.now() + 86_400_000) }) } };
  await assert.rejects(() => service(prisma).activateTrial('token'), /Trial was not selected/);
});
