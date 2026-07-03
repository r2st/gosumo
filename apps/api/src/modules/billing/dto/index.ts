import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RealtyPlan } from '@gosumo/shared';

/** Body for POST /billing/upgrade — switch a business to a new tier. */
export class UpgradePlanDto {
  @ApiProperty({ enum: RealtyPlan, description: 'Target subscription tier' })
  @IsEnum(RealtyPlan)
  plan!: RealtyPlan;
}
