import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
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
type DraftSize = { name: string; priceDelta: number };
type DraftExtra = { name: string; price: number };
type DraftItem = {
  name: string;
  description: string;
  price: number;
  action: DraftAction;
  existingItemId: string;
  branchIds: string[];
  sizes: DraftSize[];
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
              required: [
                'name',
                'description',
                'price',
                'action',
                'existingItemId',
                'branchIds',
                'sizes',
                'extras',
                'warning',
              ],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                price: { type: 'integer', minimum: 0 },
                action: { type: 'string', enum: ['CREATE', 'UPDATE_PRICE', 'SKIP'] },
                existingItemId: { type: 'string' },
                branchIds: { type: 'array', items: { type: 'string' } },
                sizes: {
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
    if (!files?.length || files.length > MENU_IMPORT_MAX_FILES)
      throw new BadRequestException('Upload 1–5 menu images');
    const extensions = files.map((file) => this.validateImage(file));
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (
      (await this.prisma.menuImport.count({
        where: { chainId, createdAt: { gte: since } },
      })) >= MENU_IMPORT_DAILY_LIMIT
    )
      throw new ConflictException('A chain may start at most 20 menu imports per 24 hours');

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
            : [...allowedBranches];
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
          await this.attachSizes(tx, chainId, item.id, itemDraft.sizes);
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
    const apiKey = process.env.GOOGLE_VISION_API_KEY?.trim();
    if (!apiKey)
      throw new ServiceUnavailableException('GOOGLE_VISION_API_KEY is required for menu OCR');
    const key = imageUrl.replace(/^\/uploads\//, '');
    const image = await readAsset(key);
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [
            {
              image: { content: image.data.toString('base64') },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
              imageContext: { languageHints: ['vi'] },
            },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    const body = (await response.json()) as {
      responses?: Array<{ fullTextAnnotation?: { text?: string }; error?: { message?: string } }>;
    };
    if (!response.ok || body.responses?.[0]?.error)
      throw new Error(
        body.responses?.[0]?.error?.message || `Google Vision rejected OCR (${response.status})`,
      );
    return body.responses?.[0]?.fullTextAnnotation?.text?.trim() ?? '';
  }

  private async runAi(context: unknown): Promise<unknown> {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey)
      throw new ServiceUnavailableException('OPENAI_API_KEY is required for menu AI structuring');
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.MENU_IMPORT_AI_MODEL?.trim() || 'gpt-4.1-mini',
        instructions:
          'Structure Vietnamese OCR text into a menu draft. Never invent names or prices. Use only supplied branch and existing item IDs. Convert k and dotted VND prices to integer VND. Put uncertain lines in unresolved and warning. For duplicate items choose UPDATE_PRICE when price differs, otherwise SKIP.',
        input: JSON.stringify(context),
        text: {
          format: {
            type: 'json_schema',
            name: 'menu_import_draft',
            strict: true,
            schema: draftSchema,
          },
        },
        store: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await response.json()) as {
      error?: { message?: string };
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    if (!response.ok)
      throw new Error(
        body.error?.message || `AI service rejected menu import (${response.status})`,
      );
    const text = body.output
      ?.flatMap((entry) => entry.content ?? [])
      .find((part) => part.type === 'output_text')?.text;
    if (!text) throw new Error('AI service returned no structured menu draft');
    return JSON.parse(text);
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
            sizes: Array.isArray(item.sizes)
              ? item.sizes
                  .map((size) => ({
                    name: String(size.name).trim().slice(0, 100),
                    priceDelta: Number(size.priceDelta),
                  }))
                  .filter(
                    (size) =>
                      size.name && Number.isInteger(size.priceDelta) && size.priceDelta >= 0,
                  )
              : [],
            extras: Array.isArray(item.extras)
              ? item.extras
                  .map((extra) => ({
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

  private async attachSizes(
    tx: Prisma.TransactionClient,
    chainId: string,
    menuItemId: string,
    sizes: DraftSize[],
  ) {
    if (!sizes.length) return;
    const signature = createHash('sha256')
      .update(
        JSON.stringify(
          sizes.map((size) => [size.name.trim().toLocaleLowerCase('vi'), size.priceDelta]),
        ),
      )
      .digest('hex')
      .slice(0, 10)
      .toUpperCase();
    const groupCode = `SIZE_IMPORT_${signature}`;
    let group = await tx.menuOptionGroup.findFirst({ where: { chainId, code: groupCode } });
    if (!group)
      group = await tx.menuOptionGroup.create({
        data: {
          chainId,
          name: 'Kích cỡ',
          code: groupCode,
          isRequired: true,
          minSelections: 1,
          maxSelections: 1,
        },
      });
    for (const [index, size] of sizes.entries()) {
      const code =
        size.name
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, '_')
          .slice(0, 50) || `SIZE_${index + 1}`;
      await tx.menuOption.upsert({
        where: { groupId_code: { groupId: group.id, code } },
        create: {
          groupId: group.id,
          name: size.name,
          code,
          priceDelta: size.priceDelta,
          isDefault: index === 0,
          displayOrder: index,
        },
        update: { name: size.name, priceDelta: size.priceDelta, isActive: true },
      });
    }
    await tx.menuItemOptionGroup.upsert({
      where: { menuItemId_groupId: { menuItemId, groupId: group.id } },
      create: { menuItemId, groupId: group.id },
      update: {},
    });
  }

  private async attachExtras(
    tx: Prisma.TransactionClient,
    chainId: string,
    menuItemId: string,
    extras: DraftExtra[],
  ) {
    for (const [index, value] of extras.entries()) {
      let extra = await tx.menuExtra.findFirst({
        where: { chainId, name: { equals: value.name, mode: 'insensitive' } },
      });
      if (!extra)
        extra = await tx.menuExtra.create({
          data: { chainId, name: value.name, price: value.price },
        });
      await tx.menuItemExtra.upsert({
        where: { menuItemId_extraId: { menuItemId, extraId: extra.id } },
        create: {
          menuItemId,
          extraId: extra.id,
          price: value.price,
          maxQuantity: 3,
          displayOrder: index,
        },
        update: { price: value.price, maxQuantity: 3, displayOrder: index },
      });
    }
  }
}
