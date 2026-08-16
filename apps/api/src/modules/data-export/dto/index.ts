import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DataExportArchiveFormat, DataExportJobStatus } from '@gosumo/database';
import { MAX_ROW_OFFSET } from '../../../common/validators/pagination.constants';

/**
 * Look a customer up by the identifier a data subject actually has.
 *
 * Nobody making an access request knows their own client UUID; they know the
 * number they messaged from or the address they ordered with. Without this the
 * operator has to search the contacts screen first and copy an id, which is
 * both friction and a chance to export the wrong person.
 *
 * "At least one of the two" is enforced in the service, not here.
 * class-validator has no object-level rule, and the usual workaround — a
 * `@ValidateIf` on a phantom property — is satisfied by a caller who simply
 * sends that property, so the constraint it appears to express is one an empty
 * body can walk past.
 */
export class ResolveSubjectDto {
  @ApiPropertyOptional({ description: 'Customer phone, E.164', example: '+919876543210' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: 'Customer email' })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;
}

/**
 * Request an asynchronous export archive.
 */
export class RequestArchiveDto {
  @ApiPropertyOptional({
    enum: DataExportArchiveFormat,
    default: DataExportArchiveFormat.JSON,
    description:
      'JSON is one document; NDJSON is one {section, record} object per line and ' +
      'streams without holding the export in memory. Both carry the same data and ' +
      'the same disclosure metadata.',
  })
  @IsOptional()
  @IsEnum(DataExportArchiveFormat)
  format?: DataExportArchiveFormat;
}

/**
 * Download an archive.
 *
 * The token is submitted in the body rather than the query string on purpose:
 * a query string lands in access logs, browser history and `Referer` headers,
 * and this one unlocks a person's entire history with the business.
 */
export class DownloadArchiveDto {
  @ApiProperty({ description: 'The download token returned when the archive was requested' })
  @IsString()
  @MaxLength(128)
  token!: string;
}

/** Filters for the archive listing. */
export class ListArchivesQueryDto {
  @ApiPropertyOptional({ description: 'Only archives for this customer' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ enum: DataExportJobStatus })
  @IsOptional()
  @IsEnum(DataExportJobStatus)
  status?: DataExportJobStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_ROW_OFFSET, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_ROW_OFFSET)
  offset?: number;
}
