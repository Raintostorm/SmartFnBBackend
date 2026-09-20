import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  OrderItemStatus,
  OrderStatus,
  ServingTaskStatus,
} from '../../../generated/prisma/client.js';

export class OrderItemResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) menuItemId!: string;
  @ApiProperty({ example: 'Grilled chicken rice' }) itemName!: string;
  @ApiProperty({ example: '75000.00', description: 'Decimal values are serialized as strings' })
  unitPrice!: string;
  @ApiProperty({ example: 2 }) quantity!: number;
  @ApiProperty({ enum: OrderItemStatus, example: OrderItemStatus.QUEUED }) status!: OrderItemStatus;
  @ApiPropertyOptional({ example: 'No onion' }) specialInstructions?: string;
  @ApiPropertyOptional({ format: 'date-time' }) queuedAt?: Date;
  @ApiPropertyOptional({ format: 'date-time' }) startedAt?: Date;
  @ApiPropertyOptional({ format: 'date-time' }) readyAt?: Date;
  @ApiPropertyOptional({ format: 'date-time' }) servedAt?: Date;
}

export class OrderResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'ORD-1726650000000-A1B2C3D4' }) orderCode!: string;
  @ApiProperty({ format: 'uuid' }) branchId!: string;
  @ApiPropertyOptional({ format: 'uuid' }) tableSessionId?: string;
  @ApiProperty({ enum: OrderStatus, example: OrderStatus.SUBMITTED }) status!: OrderStatus;
  @ApiProperty({ example: '150000.00' }) totalAmount!: string;
  @ApiProperty({ type: () => [OrderItemResponseDto] }) items!: OrderItemResponseDto[];
}

export class KitchenQueueItemResponseDto extends OrderItemResponseDto {
  @ApiProperty({
    example: { orderCode: 'ORD-001', tableId: 'uuid', table: { code: 'T-01', name: 'Table 1' } },
  })
  order!: Record<string, unknown>;

  @ApiProperty({ example: { preparationMinutes: 15, category: { name: 'Main dishes' } } })
  menuItem!: Record<string, unknown>;
}

export class ServingTaskResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderItemId!: string;
  @ApiProperty({ enum: ServingTaskStatus, example: ServingTaskStatus.WAITING })
  status!: ServingTaskStatus;
  @ApiPropertyOptional({ format: 'uuid' }) claimedByWaiterId?: string;
  @ApiProperty({ format: 'date-time' }) availableAt!: Date;
  @ApiPropertyOptional({ format: 'date-time' }) claimedAt?: Date;
  @ApiPropertyOptional({ format: 'date-time' }) servedAt?: Date;
  @ApiProperty({ type: () => OrderItemResponseDto }) orderItem!: OrderItemResponseDto;
}

export class WaiterContextResponseDto {
  @ApiProperty({ example: { id: 'uuid', chainId: 'uuid', name: 'District 1 Branch' } })
  branch!: Record<string, unknown>;
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description: 'Active branch tables and current sessions',
  })
  tables!: Record<string, unknown>[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description: 'Open, serving, or paid table sessions',
  })
  sessions!: Record<string, unknown>[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description: 'Enabled branch menu entries with menu details',
  })
  menuItems!: Record<string, unknown>[];
  @ApiProperty({ type: () => [OrderResponseDto] }) orders!: OrderResponseDto[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description: 'Current employee active work session',
  })
  workSessions!: Record<string, unknown>[];
}
