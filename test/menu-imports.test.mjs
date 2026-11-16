import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
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
          optionGroups: [],
          extras: [],
          warning: '',
        },
      ],
    },
  ],
  unresolved: [],
};

describe('Menu imports', () => {
  it('prepares an Excel draft, skips catalog matches and rejects repeated rows', async () => {
    const service = new MenuImportsService({
      menuItem: { findMany: async () => [{ name: 'Espresso', category: { name: 'Coffee' } }] },
      menuImport: { count: async () => 0, create: async ({ data }) => data },
    }, { assertCanManageChain: async () => {} });
    const rows = [
      { category: 'Coffee', name: 'espresso', price: 32000 },
      { category: 'Coffee', name: 'Latte', price: 42000 },
    ];
    const result = await service.createExcel('chain-1', rows, owner);
    assert.equal(result.status, 'WAITING_REVIEW');
    assert.deepEqual(result.draft.categories[0].items.map(i => i.action), ['SKIP', 'CREATE']);
    await assert.rejects(service.createExcel('chain-1', [...rows, rows[0]], owner));
    await assert.rejects(service.createExcel('chain-1', [{ ...rows[0], price: -1 }], owner));
  });

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

  it('converts a legacy size draft into a named menu option group', () => {
    const service = new MenuImportsService({}, {});
    const old = structuredClone(draft);
    old.categories[0].items[0].sizes = [{ name: 'Lớn', priceDelta: 5000 }];
    delete old.categories[0].items[0].optionGroups;
    const normalized = service.validateDraft(old);
    assert.deepEqual(normalized.categories[0].items[0].optionGroups, [
      {
        name: 'Kích cỡ',
        isRequired: true,
        minSelections: 1,
        maxSelections: 1,
        options: [{ name: 'Lớn', priceDelta: 5000 }],
      },
    ]);
    assert.equal('sizes' in normalized.categories[0].items[0], false);
  });

  it('links active library entries by chain and id without updating shared definitions', async () => {
    const links = [];
    const tx = {
      menuOptionGroup: { findFirst: async ({ where }) => {
        assert.deepEqual(where, { id: 'group-1', chainId: 'chain-1', isActive: true });
        return { id: 'group-1' };
      } },
      menuExtra: { findFirst: async ({ where }) => {
        assert.deepEqual(where, { id: 'extra-1', chainId: 'chain-1', isActive: true });
        return { id: 'extra-1' };
      } },
      menuItemOptionGroup: { upsert: async ({ create }) => links.push(create) },
      menuItemExtra: { upsert: async ({ create }) => links.push(create) },
    };
    const service = new MenuImportsService({}, {});
    const input = structuredClone(draft);
    const item = input.categories[0].items[0];
    item.optionGroups = [{ groupId: 'group-1', name: 'Size', isRequired: true, minSelections: 1, maxSelections: 1, options: [{name: 'S', priceDelta: 0}] }];
    item.extras = [{ extraId: 'extra-1', name: 'Flan', price: 9000, maxQuantity: 2 }];
    const saved = service.validateDraft(input).categories[0].items[0];
    await service.attachOptionGroups(tx, 'chain-1', 'item-1', saved.optionGroups);
    await service.attachExtras(tx, 'chain-1', 'item-1', saved.extras);
    assert.equal(links[0].groupId, 'group-1');
    assert.equal(links[1].extraId, 'extra-1');
    assert.equal(links[1].price, 9000);
    assert.equal(links[1].maxQuantity, 2);
    tx.menuOptionGroup.findFirst = tx.menuExtra.findFirst = async () => null;
    await assert.rejects(service.attachOptionGroups(tx, 'chain-1', 'item-1', saved.optionGroups));
    await assert.rejects(service.attachExtras(tx, 'chain-1', 'item-1', saved.extras));
    assert.equal(links.length, 2);
  });

  it('ignores OCR suggestions without a selected library id', async () => {
    const service = new MenuImportsService({}, {});
    await service.attachOptionGroups({}, 'chain-1', 'item-1', [{ name: 'Size' }]);
    await service.attachExtras({}, 'chain-1', 'item-1', [{ name: 'Flan', price: 15000 }]);
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

  it('uses the authenticated Qwen gateway for the menu draft', async () => {
    const originalFetch = globalThis.fetch;
    const originalValues = Object.fromEntries(
      ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'].map((key) => [key, process.env[key]]),
    );
    let request;
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
      const result = await service.runAi({
        texts: ['Cà phê sữa 25.000'],
        categories: [{ id: 'category-1', name: 'Cà phê' }],
        items: [
          {
            id: 'item-1',
            categoryId: 'category-1',
            name: 'CÀ PHÊ SỮA',
            price: new Prisma.Decimal('25000.00'),
          },
        ],
      });
      const body = JSON.parse(request.options.body);

      assert.equal(result.categories[0].items[0].action, 'SKIP');
      assert.equal(result.categories[0].items[0].existingItemId, 'item-1');
      assert.equal(body.messages[1].content, 'Cà phê sữa 25.000');
      assert.equal(request.url, 'http://127.0.0.1:11435/v1/chat/completions');
      assert.equal(request.options.headers.Authorization, 'Bearer qwen-test-key');
      assert.equal(body.model, 'qwen3.5:4b');
      assert.equal(body.stream, false);
      assert.equal(body.max_tokens, 4096);
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

  it('uses Qwen vision to transcribe a menu image', async () => {
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
      assert.equal(body.max_tokens, 8192);
      assert.equal('response_format' in body, false);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalValues)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('chunks long OCR text and merges duplicate draft rows', () => {
    const service = new MenuImportsService({}, {});
    const chunks = service.chunkOcrText(['A'.repeat(3200)]);
    const merged = service.mergeQwenDrafts([draft, draft]);

    assert.equal(chunks.length, 3);
    assert.ok(chunks.every((chunk) => chunk.length <= 1500));
    assert.equal(merged.categories.length, 1);
    assert.equal(merged.categories[0].items.length, 1);
  });

  it('rejects an upload before saving files when the Qwen gateway is not configured', async () => {
    const originalBaseUrl = process.env.AI_BASE_URL;
    const originalApiKey = process.env.AI_API_KEY;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    try {
      const service = new MenuImportsService({}, { assertCanManageChain: async () => undefined });
      await assert.rejects(
        () =>
          service.create(
            'chain-1',
            [{ buffer: Buffer.from('image'), mimetype: 'image/png', size: 5 }],
            owner,
          ),
        /AI_BASE_URL and AI_API_KEY/,
      );
    } finally {
      if (originalBaseUrl === undefined) delete process.env.AI_BASE_URL;
      else process.env.AI_BASE_URL = originalBaseUrl;
      if (originalApiKey === undefined) delete process.env.AI_API_KEY;
      else process.env.AI_API_KEY = originalApiKey;
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
