import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
class BranchPriceCellDto {
  @ApiProperty({ enum: ['ITEM', 'COMBO'] }) @IsIn(['ITEM', 'COMBO']) type!: 'ITEM' | 'COMBO';
  @ApiProperty() @IsUUID() productId!: string;
  @ApiProperty() @IsUUID() branchId!: string;
  @ApiProperty({ nullable: true, minimum: 0 })
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999999)
  priceOverride!: number | null;
}
export class BranchPricesDto {
  @ApiProperty({ type: [BranchPriceCellDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BranchPriceCellDto)
  updates!: BranchPriceCellDto[];
}
@Injectable()
export class BranchPricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly realtime: RealtimePublisher,
  ) {}
  async list(chainId: string, user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    const [branches, items, combos] = await this.prisma.$transaction([
      this.prisma.branch.findMany({
        where: { chainId, deletedAt: null },
        select: { id: true, name: true },
      }),
      this.prisma.branchMenuItem.findMany({
        where: {
          branch: { chainId, deletedAt: null },
          menuItem: { deletedAt: null, category: { chainId } },
        },
        include: { menuItem: { select: { id: true, name: true, price: true } } },
      }),
      this.prisma.branchCombo.findMany({
        where: { branch: { chainId, deletedAt: null }, combo: { chainId, deletedAt: null } },
        include: { combo: { select: { id: true, name: true, price: true } } },
      }),
    ]);
    return {
      branches,
      cells: [
        ...items.map((r) => ({
          type: 'ITEM',
          productId: r.menuItemId,
          branchId: r.branchId,
          name: r.menuItem.name,
          chainPrice: r.menuItem.price,
          priceOverride: r.priceOverride,
          effectivePrice: r.priceOverride ?? r.menuItem.price,
        })),
        ...combos.map((r) => ({
          type: 'COMBO',
          productId: r.comboId,
          branchId: r.branchId,
          name: r.combo.name,
          chainPrice: r.combo.price,
          priceOverride: r.priceOverride,
          effectivePrice: r.priceOverride ?? r.combo.price,
        })),
      ],
    };
  }
  async save(chainId: string, dto: BranchPricesDto, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    if (!Array.isArray(dto.updates) || !dto.updates.length || dto.updates.length > 500)
      throw new BadRequestException('Supply 1–500 price cells');
    const keys = dto.updates.map((c) => `${c.type}:${c.productId}:${c.branchId}`);
    if (new Set(keys).size !== keys.length) throw new BadRequestException('Duplicate price cell');
    const cells = await this.prisma.$transaction(async (tx) => {
      const results = [];
      for (const cell of dto.updates) {
        const value = cell.priceOverride;
        if (
          !['ITEM', 'COMBO'].includes(cell.type) ||
          (value !== null &&
            (typeof value !== 'number' ||
              !Number.isFinite(value) ||
              value < 0 ||
              value > 99999999999 ||
              Math.abs(value * 100 - Math.round(value * 100)) > 0.001))
        )
          throw new BadRequestException('Invalid price override');
        if (!(await tx.branch.count({ where: { id: cell.branchId, chainId, deletedAt: null } })))
          throw new BadRequestException('Branch outside chain');
        let before, base;
        if (cell.type === 'ITEM') {
          const row = await tx.branchMenuItem.findFirst({
            where: {
              branchId: cell.branchId,
              menuItemId: cell.productId,
              menuItem: { deletedAt: null, category: { chainId } },
            },
            include: { menuItem: { select: { price: true } } },
          });
          if (!row) throw new NotFoundException('Item is not assigned to branch');
          before = row.priceOverride;
          base = row.menuItem.price;
          await tx.branchMenuItem.update({
            where: { branchId_menuItemId: { branchId: cell.branchId, menuItemId: cell.productId } },
            data: { priceOverride: value },
          });
        } else {
          const row = await tx.branchCombo.findFirst({
            where: {
              branchId: cell.branchId,
              comboId: cell.productId,
              combo: { chainId, deletedAt: null },
            },
            include: { combo: { select: { price: true } } },
          });
          if (!row) throw new NotFoundException('Combo is not assigned to branch');
          before = row.priceOverride;
          base = row.combo.price;
          await tx.branchCombo.update({
            where: { branchId_comboId: { branchId: cell.branchId, comboId: cell.productId } },
            data: { priceOverride: value },
          });
        }
        await tx.branchAuditLog.create({
          data: {
            branchId: cell.branchId,
            actorUserId: user.id,
            actorRole: user.role,
            action: 'MENU_BRANCH_PRICE_CHANGED',
            entityType: cell.type,
            entityId: cell.productId,
            before: { priceOverride: before?.toString() ?? null },
            after: { priceOverride: value },
          },
        });
        results.push({
          ...cell,
          effectivePrice: value ?? base,
          warnings:
            value !== null && (value < Number(base) * 0.5 || value > Number(base) * 2)
              ? ['PRICE_OUTSIDE_CHAIN_RANGE']
              : [],
        });
      }
      return results;
    });
    for (const branchId of new Set(cells.map((c) => c.branchId)))
      this.realtime.branch(branchId, 'menu.prices-updated', {});
    return { cells };
  }
}
@ApiTags('Menu - chain wide (OWNER)')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.OWNER)
@Controller('restaurant-chains/:chainId/branch-prices')
export class BranchPricesController {
  constructor(private readonly service: BranchPricesService) {}
  @Get()
  @ApiOperation({ summary: 'Read item and combo branch price matrix' })
  list(@Param('chainId', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(id, user);
  }
  @Put()
  @ApiOperation({
    summary: 'Atomically update 1–500 branch price cells; null restores chain price',
  })
  save(
    @Param('chainId', ParseUUIDPipe) id: string,
    @Body() dto: BranchPricesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.save(id, dto, user);
  }
}
