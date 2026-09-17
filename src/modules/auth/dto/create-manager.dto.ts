import { OmitType } from '@nestjs/swagger';
import { CreateStaffDto } from './create-staff.dto.js';

export class CreateManagerDto extends OmitType(CreateStaffDto, ['role'] as const) {}
