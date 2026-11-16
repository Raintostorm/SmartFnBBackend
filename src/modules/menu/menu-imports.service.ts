import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, MenuImportStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { putAsset, readAsset } from '../assets/asset-storage.js';

export const MENU_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const MENU_IMPORT_MAX_FILES = 5;
export const MENU_IMPORT_DAILY_LIMIT = 20;

export interface MenuImportFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

type DraftAction = 'CREATE' | 'UPDATE_PRICE' | 'SKIP';
type DraftOption = { name: string; priceDelta: number };
type DraftOptionGroup = {
  groupId?: string;
  name: string;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number;
  options: DraftOption[];
};
type DraftExtra = { extraId?: string; maxQuantity?: number; name: string; price: number };
type DraftItem = {
  name: string;
  description: string;
  price: number;
  action: DraftAction;
  existingItemId: string;
  branchIds: string[];
  optionGroups: DraftOptionGroup[];
  /** Older drafts are normalized to optionGroups before review or commit. */
  sizes?: DraftOption[];
  extras: DraftExtra[];
  warning: string;
};
type MenuImportDraft = {
  categories: Array<{ name: string; items: DraftItem[] }>;
  unresolved: string[];
};

const draftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['categories', 'unresolved'],
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'items'],
        properties: {
          name: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'price'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                price: { type: 'integer', minimum: 0 },
                optionGroups: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name', 'isRequired', 'minSelections', 'maxSelections', 'options'],
                    properties: {
                      name: { type: 'string' },
                      isRequired: { type: 'boolean' },
                      minSelections: { type: 'integer', minimum: 0 },
                      maxSelections: { type: 'integer', minimum: 1 },
                      options: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          required: ['name', 'priceDelta'],
                          properties: {
                            name: { type: 'string' },
                            priceDelta: { type: 'integer', minimum: 0 },
                          },
                        },
                      },
                    },
                  },
                },
                extras: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name', 'price'],
                    properties: {
                      name: { type: 'string' },
                      price: { type: 'integer', minimum: 0 },
                    },
                  },
                },
                warning: { type: 'string' },
              },
            },
          },
        },
      },
    },
    unresolved: { type: 'array', items: { type: 'string' } },
  },
} as const;

@Injectable()
export class MenuImportsService implements OnModuleInit {
  private readonly logger = new Logger(MenuImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
  ) {}

  async onModuleInit() {
    try {
      const now = new Date();
      await this.prisma.menuImport.updateMany({
        where: {
          status: { in: [MenuImportStatus.PROCESSING, MenuImportStatus.WAITING_REVIEW] },
          expiresAt: { lte: now },
        },
        data: { status: MenuImportStatus.CANCELLED, cancelledAt: now },
      });
      const pending = await this.prisma.menuImport.findMany({
        where: { status: MenuImportStatus.PROCESSING, expiresAt: { gt: now } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      for (const record of pending) setImmediate(() => void this.process(record.id));
    } catch (error) {
      this.logger.warn(
        `Could not resume pending menu imports: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async create(chainId: string, files: MenuImportFile[] | undefined, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    this.qwenConfig();
    if (!files?.length || files.length > MENU_IMPORT_MAX_FILES)
      throw new BadRequestException('Upload 1–5 menu images');
    const extensions = files.map((file) => this.validateImage(file));
    await this.checkImportLimit(chainId);

    const keys: string[] = [];
    for (const [index, file] of files.entries()) {
      const key = `menu/import-${chainId}-${randomUUID()}-${index + 1}.${extensions[index]}`;
      await putAsset(key, file.buffer);
      keys.push(key);
    }
    const record = await this.prisma.menuImport.create({
      data: {
        chainId,
        createdById: user.id,
        imageUrls: keys.map((key) => `/uploads/${key}`),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    setImmediate(() => void this.process(record.id));
    return record;
  }

  private async checkImportLimit(chainId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (
      (await this.prisma.menuImport.count({
        where: { chainId, createdAt: { gte: since } },
      })) >= MENU_IMPORT_DAILY_LIMIT
    )
      throw new ConflictException('A chain may start at most 20 menu imports per 24 hours');
  }

  async createExcel(chainId: string, rows: unknown, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    if (!Array.isArray(rows) || !rows.length || rows.length > 500)
      throw new BadRequestException('File Excel cần có từ 1 đến 500 món');
    await this.checkImportLimit(chainId);
    const existing = await this.prisma.menuItem.findMany({
      where: { deletedAt: null, category: { chainId, deletedAt: null } },
      select: { name: true, category: { select: { name: true } } },
    });
    const key = (s: string) => s.trim().normalize('NFC').toLocaleLowerCase('vi');
    const itemKey = (category: string, name: string) => JSON.stringify([key(category), key(name)]);
    const known = new Set(existing.map(item => itemKey(item.category.name, item.name)));
    const seen = new Set<string>();
    const categories = new Map<string, MenuImportDraft['categories'][number]>();
    for (const [index, row] of rows.entries()) {
      if (typeof row?.category !== 'string' || !row.category.trim() || row.category.length > 150 ||
          typeof row.name !== 'string' || !row.name.trim() || row.name.length > 150 ||
          !Number.isSafeInteger(row.price) || row.price < 0 || row.price > 2147483647 ||
          (row.description !== undefined && (typeof row.description !== 'string' || row.description.length > 2000)))
        throw new BadRequestException(`Dữ liệu món thứ ${index + 1} không hợp lệ`);
      const id = itemKey(row.category, row.name);
      if (seen.has(id)) throw new BadRequestException(`Món "${row.name}" xuất hiện hai lần trong danh mục "${row.category}"`);
      seen.add(id);
      const categoryKey = key(row.category);
      const category: MenuImportDraft['categories'][number] = categories.get(categoryKey) ?? { name: row.category.trim(), items: [] };
      const duplicate = known.has(id);
      category.items.push({
        name: row.name.trim(), price: row.price, description: row.description?.trim() ?? '',
        action: duplicate ? 'SKIP' : 'CREATE', existingItemId: '', branchIds: [], optionGroups: [], extras: [],
        warning: duplicate ? 'Món đã có trong danh mục. Chọn Cập nhật giá nếu muốn đổi giá.' : '',
      });
      categories.set(categoryKey, category);
    }
    const draft = { categories: [...categories.values()], unresolved: [] };
    return this.prisma.menuImport.create({
      data: { chainId, createdById: user.id, status: MenuImportStatus.WAITING_REVIEW,
        imageUrls: [], draft: draft as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    });
  }

  async get(chainId: string, id: string, user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    const record = await this.prisma.menuImport.findFirst({ where: { id, chainId } });
    if (!record) throw new NotFoundException('Menu import not found');
    return record;
  }

  async updateDraft(chainId: string, id: string, draft: unknown, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    const normalized = this.validateDraft(draft);
    const updated = await this.prisma.menuImport.updateMany({
      where: {
        id,
        chainId,
        status: MenuImportStatus.WAITING_REVIEW,
        expiresAt: { gt: new Date() },
      },
      data: { draft: normalized as unknown as Prisma.InputJsonValue },
    });
    if (!updated.count)
      throw new ConflictException('Only an unexpired draft waiting for review can be edited');
    return this.get(chainId, id, user);
  }

  async cancel(chainId: string, id: string, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    const updated = await this.prisma.menuImport.updateMany({
      where: {
        id,
        chainId,
        status: { in: [MenuImportStatus.PROCESSING, MenuImportStatus.WAITING_REVIEW] },
      },
      data: { status: MenuImportStatus.CANCELLED, cancelledAt: new Date() },
    });
    if (!updated.count) throw new ConflictException('This menu import can no longer be cancelled');
    return { id, status: MenuImportStatus.CANCELLED };
  }

  async commit(chainId: string, id: string, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM menu_imports WHERE id = ${id}::uuid FOR UPDATE`;
      const record = await tx.menuImport.findFirst({ where: { id, chainId } });
      if (!record) throw new NotFoundException('Menu import not found');
      if (record.status !== MenuImportStatus.WAITING_REVIEW || record.expiresAt <= new Date())
        throw new ConflictException('Only an unexpired draft waiting for review can be imported');
      const draft = this.validateDraft(record.draft);
      const activeBranches = await tx.branch.findMany({
        where: { chainId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      });
      const allowedBranches = new Set(activeBranches.map((branch) => branch.id));
      const result = { created: 0, updated: 0, skipped: 0 };

      for (const [categoryIndex, categoryDraft] of draft.categories.entries()) {
        let category = await tx.menuCategory.findFirst({
          where: {
            chainId,
            name: { equals: categoryDraft.name, mode: 'insensitive' },
            deletedAt: null,
          },
        });
        if (!category) {
          category = await tx.menuCategory.create({
            data: { chainId, name: categoryDraft.name, displayOrder: categoryIndex },
          });
        }
        for (const itemDraft of categoryDraft.items) {
          if (itemDraft.action === 'SKIP') {
            result.skipped += 1;
            continue;
          }
          const branchIds = itemDraft.branchIds.length
            ? [...new Set(itemDraft.branchIds)]
            : itemDraft.action === 'CREATE'
              ? [...allowedBranches]
              : [];
          if (branchIds.some((branchId) => !allowedBranches.has(branchId)))
            throw new BadRequestException(`Branch selection is invalid for ${itemDraft.name}`);

          let item = itemDraft.existingItemId
            ? await tx.menuItem.findFirst({
                where: { id: itemDraft.existingItemId, deletedAt: null, category: { chainId } },
              })
            : await tx.menuItem.findFirst({
                where: {
                  name: { equals: itemDraft.name, mode: 'insensitive' },
                  categoryId: category.id,
                  deletedAt: null,
                },
              });
          if (itemDraft.action === 'UPDATE_PRICE') {
            if (!item)
              throw new BadRequestException(`Existing item not found for ${itemDraft.name}`);
            item = await tx.menuItem.update({
              where: { id: item.id },
              data: { price: itemDraft.price },
            });
            result.updated += 1;
          } else {
            if (item) throw new ConflictException(`Menu item ${itemDraft.name} already exists`);
            item = await tx.menuItem.create({
              data: {
                categoryId: category.id,
                sku: this.createSku(itemDraft.name),
                name: itemDraft.name,
                description: itemDraft.description || null,
                price: itemDraft.price,
                allowBatching: true,
              },
            });
            result.created += 1;
          }
          for (const branchId of branchIds)
            await tx.branchMenuItem.upsert({
              where: { branchId_menuItemId: { branchId, menuItemId: item.id } },
              create: { branchId, menuItemId: item.id },
              update: { isEnabled: true },
            });
          await this.attachOptionGroups(tx, chainId, item.id, itemDraft.optionGroups);
          await this.attachExtras(tx, chainId, item.id, itemDraft.extras);
        }
      }
      for (const branch of activeBranches)
        await tx.branchAuditLog.create({
          data: {
            branchId: branch.id,
            actorUserId: user.id,
            actorRole: user.role,
            action: 'MENU_IMPORT_COMMITTED',
            entityType: 'MENU_IMPORT',
            entityId: id,
            after: result,
          },
        });
      return tx.menuImport.update({
        where: { id },
        data: {
          status: MenuImportStatus.IMPORTED,
          importedAt: new Date(),
          result,
        },
      });
    });
  }

  async process(id: string): Promise<void> {
    const record = await this.prisma.menuImport.findUnique({ where: { id } });
    if (!record || record.status !== MenuImportStatus.PROCESSING) return;
    try {
      const imageUrls = record.imageUrls as string[];
      const texts: string[] = [];
      for (const imageUrl of imageUrls) texts.push(await this.runOcr(imageUrl));
      if (!texts.some((text) => text.trim())) throw new Error('OCR could not read any menu text');
      const [categories, items, branches] = await this.prisma.$transaction([
        this.prisma.menuCategory.findMany({
          where: { chainId: record.chainId, deletedAt: null },
          select: { id: true, name: true },
        }),
        this.prisma.menuItem.findMany({
          where: { category: { chainId: record.chainId }, deletedAt: null },
          select: { id: true, categoryId: true, name: true, price: true },
        }),
        this.prisma.branch.findMany({
          where: { chainId: record.chainId, deletedAt: null, status: 'ACTIVE' },
          select: { id: true, name: true },
        }),
      ]);
      const draft = this.validateDraft(await this.runAi({ texts, categories, items, branches }));
      await this.prisma.menuImport.updateMany({
        where: { id, status: MenuImportStatus.PROCESSING },
        data: {
          status: MenuImportStatus.WAITING_REVIEW,
          ocrText: texts,
          draft: draft as unknown as Prisma.InputJsonValue,
          errorReason: null,
        },
      });
    } catch (error) {
      await this.prisma.menuImport.updateMany({
        where: { id, status: MenuImportStatus.PROCESSING },
        data: {
          status: MenuImportStatus.FAILED,
          errorReason: String(error instanceof Error ? error.message : error).slice(0, 1000),
        },
      });
    }
  }

  private async runOcr(imageUrl: string): Promise<string> {
    const key = imageUrl.replace(/^\/uploads\//, '');
    return this.runQwenOcr(await readAsset(key));
  }

  private async runAi(context: unknown): Promise<unknown> {
    return this.runQwen(context);
  }

  private async runQwen(context: unknown): Promise<unknown> {
    const source = context as Record<string, unknown>;
    const texts = Array.isArray(source?.texts) ? source.texts.map(String) : [];
    const chunks = this.chunkOcrText(texts);
    const drafts: MenuImportDraft[] = [];

    for (const chunk of chunks) {
      const text = await this.requestQwen(
        [
          {
            role: 'system',
            content:
              'Extract Vietnamese menu categories, items and prices as compact JSON. Put choices such as size, temperature or sugar level into named optionGroups with options; use isRequired/minSelections/maxSelections to describe the selection rule. Put separately priced add-ons in extras. Omit optional fields unless explicitly present. Apply a category price to its items when clear. Convert k and dotted VND prices to integer VND. Include each item once. Put uncertain lines in unresolved. Never invent names or prices.',
          },
          { role: 'user', content: chunk },
        ],
        4096,
        {
          type: 'json_schema',
          json_schema: { name: 'menu_import_draft', strict: true, schema: draftSchema },
        },
      );
      const extracted = JSON.parse(text) as MenuImportDraft;
      for (const category of extracted.categories) {
        const categoryId = this.findMenuCategoryId(source.categories, category.name);
        for (const item of category.items) {
          const matches = Array.isArray(source.items)
            ? source.items.filter(
                (candidate) =>
                  categoryId &&
                  candidate.categoryId === categoryId &&
                  this.menuNameKey(candidate.name) === this.menuNameKey(item.name),
              )
            : [];
          const existing = matches.length === 1 ? matches[0] : undefined;
          item.action = existing
            ? new Prisma.Decimal(existing.price).equals(item.price)
              ? 'SKIP'
              : 'UPDATE_PRICE'
            : 'CREATE';
          item.existingItemId = existing?.id ?? '';
          item.branchIds = [];
        }
      }
      drafts.push(this.validateDraft(extracted));
    }
    return this.mergeQwenDrafts(drafts);
  }

  private findMenuCategoryId(value: unknown, name: string): string | undefined {
    if (!Array.isArray(value)) return undefined;
    const matches = value.filter(
      (category) => this.menuNameKey(category.name) === this.menuNameKey(name),
    );
    return matches.length === 1 ? matches[0].id : undefined;
  }

  private menuNameKey(value: string): string {
    return value.normalize('NFC').trim().toLocaleLowerCase('vi');
  }

  private chunkOcrText(texts: string[]): string[] {
    const maxChars = 1500;
    const chunks: string[] = [];
    let current = '';
    const flush = () => {
      if (current.trim()) chunks.push(current.trim());
      current = '';
    };
    for (const text of texts) {
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        for (let offset = 0; offset < line.length; offset += maxChars) {
          const part = line.slice(offset, offset + maxChars);
          if (current && current.length + part.length + 1 > maxChars) flush();
          current += `${current ? '\n' : ''}${part}`;
        }
      }
    }
    flush();
    return chunks.length ? chunks : [''];
  }

  private mergeQwenDrafts(drafts: MenuImportDraft[]): MenuImportDraft {
    const categories = new Map<string, MenuImportDraft['categories'][number]>();
    const seenItems = new Set<string>();
    const unresolved = new Set<string>();
    for (const draft of drafts) {
      for (const category of Array.isArray(draft?.categories) ? draft.categories : []) {
        const categoryKey = String(category?.name ?? '')
          .trim()
          .toLocaleLowerCase('vi');
        if (!categoryKey) continue;
        let target = categories.get(categoryKey);
        if (!target) {
          target = { name: String(category.name).trim(), items: [] };
          categories.set(categoryKey, target);
        }
        for (const item of Array.isArray(category.items) ? category.items : []) {
          const itemKey = [
            categoryKey,
            String(item?.name ?? '')
              .trim()
              .toLocaleLowerCase('vi'),
            Number(item?.price),
            String(item?.action ?? ''),
            String(item?.existingItemId ?? ''),
          ].join('|');
          if (!seenItems.has(itemKey)) {
            seenItems.add(itemKey);
            target.items.push(item);
          }
        }
      }
      for (const value of Array.isArray(draft?.unresolved) ? draft.unresolved : []) {
        const text = String(value).trim();
        if (text) unresolved.add(text);
      }
    }
    return { categories: [...categories.values()], unresolved: [...unresolved] };
  }

  private async runQwenOcr(image: { data: Buffer; contentType: string }): Promise<string> {
    return this.requestQwen(
      [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Transcribe every visible menu line exactly. Preserve Vietnamese diacritics, category headings, item names, descriptions, sizes, and prices. Keep the visual reading order. Do not explain, correct, translate, or invent text. Return plain text only.',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${image.contentType};base64,${image.data.toString('base64')}`,
              },
            },
          ],
        },
      ],
      8192,
    );
  }

  private async requestQwen(
    messages: unknown[],
    maxTokens: number,
    responseFormat?: unknown,
  ): Promise<string> {
    const { baseUrl, apiKey } = this.qwenConfig();
    const model = process.env.AI_MODEL?.trim() || 'qwen3.5:4b';
    const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS || 190_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000)
      throw new ServiceUnavailableException(
        'AI_REQUEST_TIMEOUT_MS must be an integer of at least 1000',
      );
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    const accessClientId = process.env.CF_ACCESS_CLIENT_ID?.trim();
    const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();
    if (accessClientId && accessClientSecret) {
      headers['CF-Access-Client-Id'] = accessClientId;
      headers['CF-Access-Client-Secret'] = accessClientSecret;
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: 0,
        max_tokens: maxTokens,
        reasoning_effort: 'none',
        response_format: responseFormat,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json()) as {
      error?: { message?: string };
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
    };
    if (!response.ok)
      throw new Error(
        body.error?.message || `Qwen gateway rejected menu import (${response.status})`,
      );
    if (body.choices?.[0]?.finish_reason === 'length')
      throw new Error('Qwen output exceeded the configured token limit');
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error('Qwen gateway returned no content');
    return text;
  }

  private qwenConfig(): { baseUrl: string; apiKey: string } {
    const baseUrl = process.env.AI_BASE_URL?.trim().replace(/\/+$/, '');
    const apiKey = process.env.AI_API_KEY?.trim();
    if (!baseUrl || !apiKey)
      throw new ServiceUnavailableException('AI_BASE_URL and AI_API_KEY are required for Qwen');
    if (!baseUrl.startsWith('https://') && process.env.NODE_ENV === 'production')
      throw new ServiceUnavailableException('AI_BASE_URL must use HTTPS in production');
    return { baseUrl, apiKey };
  }

  private validateDraft(value: unknown): MenuImportDraft {
    if (
      !value ||
      typeof value !== 'object' ||
      !Array.isArray((value as MenuImportDraft).categories)
    )
      throw new BadRequestException('Menu import draft must contain categories');
    const raw = value as MenuImportDraft;
    const categories = raw.categories.map((category) => {
      if (!category?.name?.trim() || !Array.isArray(category.items))
        throw new BadRequestException('Every draft category needs a name and items');
      return {
        name: category.name.trim().slice(0, 150),
        items: category.items.map((item) => {
          if (!item?.name?.trim() || !Number.isInteger(item.price) || item.price < 0)
            throw new BadRequestException('Every imported item needs a name and a whole VND price');
          if (!['CREATE', 'UPDATE_PRICE', 'SKIP'].includes(item.action))
            throw new BadRequestException('Invalid duplicate handling action');
          return {
            name: item.name.trim().slice(0, 150),
            description: String(item.description ?? '')
              .trim()
              .slice(0, 2000),
            price: item.price,
            action: item.action,
            existingItemId: String(item.existingItemId ?? ''),
            branchIds: Array.isArray(item.branchIds) ? item.branchIds.map(String) : [],
            optionGroups: (Array.isArray(item.optionGroups)
              ? item.optionGroups
              : Array.isArray(item.sizes) && item.sizes.length
                ? [
                    {
                      name: 'Kích cỡ',
                      isRequired: true,
                      minSelections: 1,
                      maxSelections: 1,
                      options: item.sizes,
                    },
                  ]
                : []
            ).map((group) => {
              const options = Array.isArray(group.options)
                ? group.options
                    .map((option) => ({
                      name: String(option.name ?? '')
                        .trim()
                        .slice(0, 100),
                      priceDelta: Number(option.priceDelta),
                    }))
                    .filter(
                      (option) =>
                        option.name &&
                        Number.isInteger(option.priceDelta) &&
                        option.priceDelta >= 0,
                    )
                : [];
              const name = String(group.name ?? '')
                .trim()
                .slice(0, 100);
              const isRequired = group.isRequired === true;
              const minSelections = Number(group.minSelections ?? (isRequired ? 1 : 0));
              const maxSelections = Number(group.maxSelections ?? 1);
              if (
                !name ||
                (!group.groupId && !options.length) ||
                !Number.isInteger(minSelections) ||
                !Number.isInteger(maxSelections) ||
                isRequired !== minSelections > 0 ||
                maxSelections < Math.max(1, minSelections) ||
                (!group.groupId && maxSelections > options.length) ||
                new Set(options.map((option) => option.name.toLocaleLowerCase('vi'))).size !==
                  options.length
              )
                throw new BadRequestException(`Invalid option group for ${item.name}`);
              return { ...(group.groupId && { groupId: group.groupId }), name, isRequired, minSelections, maxSelections, options };
            }),
            extras: Array.isArray(item.extras)
              ? item.extras
                  .map((extra) => ({
                    ...(extra.extraId && { extraId: extra.extraId }),
                    ...(extra.maxQuantity !== undefined && { maxQuantity: extra.maxQuantity }),
                    name: String(extra.name).trim().slice(0, 100),
                    price: Number(extra.price),
                  }))
                  .filter(
                    (extra) => extra.name && Number.isInteger(extra.price) && extra.price >= 0,
                  )
              : [],
            warning: String(item.warning ?? '')
              .trim()
              .slice(0, 500),
          };
        }),
      };
    });
    return {
      categories,
      unresolved: Array.isArray(raw.unresolved) ? raw.unresolved.map(String).slice(0, 100) : [],
    };
  }

  private validateImage(file: MenuImportFile): 'jpg' | 'png' | 'webp' {
    if (
      !file?.buffer?.length ||
      file.size > MENU_IMPORT_MAX_BYTES ||
      file.buffer.length > MENU_IMPORT_MAX_BYTES
    )
      throw new BadRequestException('Each menu image must be non-empty and at most 10 MB');
    const b = file.buffer;
    if (
      file.mimetype === 'image/jpeg' &&
      b.length >= 3 &&
      b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    )
      return 'jpg';
    if (
      file.mimetype === 'image/png' &&
      b.length >= 8 &&
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
      return 'png';
    if (
      file.mimetype === 'image/webp' &&
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP'
    )
      return 'webp';
    throw new BadRequestException(
      'Menu imports accept JPEG, PNG, or WebP images with matching file signatures',
    );
  }

  private createSku(name: string): string {
    const stem =
      name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 34) || 'ITEM';
    return `IMPORT-${stem}-${randomUUID().slice(0, 6).toUpperCase()}`;
  }

  private async attachOptionGroups(
    tx: Prisma.TransactionClient,
    chainId: string,
    menuItemId: string,
    groups: DraftOptionGroup[],
  ) {
    for (const [groupIndex, value] of groups.entries()) {
      if (!value.groupId) continue;
      const group = await tx.menuOptionGroup.findFirst({
        where: { id: value.groupId, chainId, isActive: true },
        select: { id: true },
      });
      if (!group) throw new BadRequestException(`Nhóm tùy chọn "${value.name}" không còn khả dụng`);
      await tx.menuItemOptionGroup.upsert({
        where: { menuItemId_groupId: { menuItemId, groupId: group.id } },
        create: { menuItemId, groupId: group.id, displayOrder: groupIndex },
        update: { displayOrder: groupIndex },
      });
    }
  }

  private async attachExtras(
    tx: Prisma.TransactionClient,
    chainId: string,
    menuItemId: string,
    extras: DraftExtra[],
  ) {
    for (const [index, value] of extras.entries()) {
      if (!value.extraId) continue;
      const maxQuantity = value.maxQuantity ?? 3;
      if (!Number.isInteger(maxQuantity) || maxQuantity < 1 || maxQuantity > 5)
        throw new BadRequestException('Số phần topping phải từ 1 đến 5');
      const extra = await tx.menuExtra.findFirst({
        where: { id: value.extraId, chainId, isActive: true },
      });
      if (!extra)
        throw new BadRequestException(`Topping "${value.name}" không còn khả dụng`);
      await tx.menuItemExtra.upsert({
        where: { menuItemId_extraId: { menuItemId, extraId: extra.id } },
        create: {
          menuItemId,
          extraId: extra.id,
          price: value.price,
          maxQuantity,
          displayOrder: index,
        },
        update: { price: value.price, maxQuantity, displayOrder: index },
      });
    }
  }
}
