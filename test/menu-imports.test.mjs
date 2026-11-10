import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MenuImportsService } from '../dist/modules/menu/menu-imports.service.js';

const owner = { id: 'user-1', role: 'OWNER', ownerId: 'owner-1' };
const draft = {
  categories: [
    {
      name: 'Cà phê',
      items: [
        {
          name: 'Cà phê sữa',
          description: '',
          price: 25000,
          action: 'SKIP',
          existingItemId: '',
          branchIds: [],
          sizes: [],
          extras: [],
          warning: '',
        },
      ],
    },
  ],
  unresolved: [],
};

describe('Menu imports', () => {
  it('saves a reviewed draft without writing any menu rows', async () => {
    let update;
    const record = {
      id: 'import-1',
      chainId: 'chain-1',
      status: 'WAITING_REVIEW',
      draft,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma = {
      menuImport: {
        updateMany: async (args) => {
          update = args;
          return { count: 1 };
        },
        findFirst: async () => record,
      },
    };
    const access = {
      assertCanManageChain: async () => undefined,
      assertCanAccessChain: async () => undefined,
    };
    const service = new MenuImportsService(prisma, access);

    const result = await service.updateDraft('chain-1', 'import-1', draft, owner);

    assert.equal(result.id, 'import-1');
    assert.equal(update.where.status, 'WAITING_REVIEW');
    assert.deepEqual(update.data.draft, draft);
    assert.equal('menuItem' in prisma, false);
  });

  it('marks OCR/AI failures as FAILED without touching the menu', async () => {
    let failedUpdate;
    const prisma = {
      menuImport: {
        findUnique: async () => ({
          id: 'import-1',
          chainId: 'chain-1',
          status: 'PROCESSING',
          imageUrls: ['/uploads/menu/import-test.png'],
        }),
        updateMany: async (args) => {
          failedUpdate = args;
          return { count: 1 };
        },
      },
    };
    const service = new MenuImportsService(prisma, {});
    service.runOcr = async () => {
      throw new Error('OCR unavailable');
    };

    await service.process('import-1');

    assert.equal(failedUpdate.data.status, 'FAILED');
    assert.match(failedUpdate.data.errorReason, /OCR unavailable/);
    assert.equal('menuItem' in prisma, false);
  });

  it('uses Gemini structured output for the menu draft', async () => {
    const originalFetch = globalThis.fetch;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalModel = process.env.MENU_IMPORT_AI_MODEL;
    let request;
    process.env.GEMINI_API_KEY = 'gemini-test-key';
    process.env.MENU_IMPORT_AI_MODEL = 'models/gemini-test-model';
    globalThis.fetch = async (url, options) => {
      request = { url: String(url), options };
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    try {
      const service = new MenuImportsService({}, {});
      const result = await service.runAi({ texts: ['Cà phê sữa 25.000'] });
      const body = JSON.parse(request.options.body);

      assert.deepEqual(result, draft);
      assert.equal(
        request.url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent',
      );
      assert.equal(request.options.headers['x-goog-api-key'], 'gemini-test-key');
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.deepEqual(body.generationConfig.responseJsonSchema.required, [
        'categories',
        'unresolved',
      ]);
      assert.equal(body.contents[0].role, 'user');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      if (originalModel === undefined) delete process.env.MENU_IMPORT_AI_MODEL;
      else process.env.MENU_IMPORT_AI_MODEL = originalModel;
    }
  });

  it('uses the authenticated Qwen gateway when selected', async () => {
    const originalFetch = globalThis.fetch;
    const originalValues = Object.fromEntries(
      ['MENU_IMPORT_AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'].map((key) => [
        key,
        process.env[key],
      ]),
    );
    let request;
    process.env.MENU_IMPORT_AI_PROVIDER = 'qwen';
    process.env.AI_BASE_URL = 'http://127.0.0.1:11435/v1/';
    process.env.AI_API_KEY = 'qwen-test-key';
    process.env.AI_MODEL = 'qwen3.5:4b';
    globalThis.fetch = async (url, options) => {
      request = { url: String(url), options };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    try {
      const service = new MenuImportsService({}, {});
      const result = await service.runAi({ texts: ['Cà phê sữa 25.000'] });
      const body = JSON.parse(request.options.body);

      assert.deepEqual(result, draft);
      assert.equal(request.url, 'http://127.0.0.1:11435/v1/chat/completions');
      assert.equal(request.options.headers.Authorization, 'Bearer qwen-test-key');
      assert.equal(body.model, 'qwen3.5:4b');
      assert.equal(body.stream, false);
      assert.equal(body.response_format.type, 'json_schema');
      assert.deepEqual(body.response_format.json_schema.schema.required, [
        'categories',
        'unresolved',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalValues)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('uses Qwen vision to transcribe an image without Google Vision', async () => {
    const originalFetch = globalThis.fetch;
    const originalValues = Object.fromEntries(
      ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'].map((key) => [key, process.env[key]]),
    );
    let request;
    process.env.AI_BASE_URL = 'http://127.0.0.1:11435/v1';
    process.env.AI_API_KEY = 'qwen-test-key';
    process.env.AI_MODEL = 'qwen3.5:4b';
    globalThis.fetch = async (url, options) => {
      request = { url: String(url), options };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'Cà phê sữa 25.000' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    try {
      const service = new MenuImportsService({}, {});
      const result = await service.runQwenOcr({
        data: Buffer.from('test-image'),
        contentType: 'image/png',
      });
      const body = JSON.parse(request.options.body);
      const imagePart = body.messages[0].content[1];

      assert.equal(result, 'Cà phê sữa 25.000');
      assert.equal(request.url, 'http://127.0.0.1:11435/v1/chat/completions');
      assert.equal(imagePart.type, 'image_url');
      assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);
      assert.equal('response_format' in body, false);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalValues)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('commits a reviewed draft once and records skipped rows in the audit result', async () => {
    const auditRows = [];
    const imported = [];
    const tx = {
      $queryRaw: async () => [],
      menuImport: {
        findFirst: async () => ({
          id: 'import-1',
          chainId: 'chain-1',
          status: 'WAITING_REVIEW',
          expiresAt: new Date(Date.now() + 60_000),
          draft,
        }),
        update: async ({ data }) => {
          imported.push(data);
          return { id: 'import-1', ...data };
        },
      },
      branch: { findMany: async () => [{ id: 'branch-1' }] },
      menuCategory: {
        findFirst: async () => ({ id: 'category-1', name: 'Cà phê' }),
      },
      branchAuditLog: {
        create: async ({ data }) => {
          auditRows.push(data);
          return data;
        },
      },
    };
    const prisma = { $transaction: async (work) => work(tx) };
    const access = { assertCanManageChain: async () => undefined };
    const service = new MenuImportsService(prisma, access);

    const result = await service.commit('chain-1', 'import-1', owner);

    assert.equal(result.status, 'IMPORTED');
    assert.deepEqual(imported[0].result, { created: 0, updated: 0, skipped: 1 });
    assert.equal(auditRows[0].action, 'MENU_IMPORT_COMMITTED');
    assert.equal('menuItem' in tx, false);
  });
});
