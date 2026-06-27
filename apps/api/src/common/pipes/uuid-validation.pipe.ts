import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  BadRequestException,
} from '@nestjs/common';
import { validate as isUuid } from 'uuid';

/**
 * UuidValidationPipe — validates that a path parameter is a valid v4 UUID.
 *
 * Usage:
 *   @Get(':id')
 *   findOne(@Param('id', UuidValidationPipe) id: string) { ... }
 */
@Injectable()
export class UuidValidationPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (!value) {
      throw new BadRequestException(
        `${metadata.data ?? 'Parameter'} is required`,
      );
    }

    if (!isUuid(value)) {
      throw new BadRequestException(
        `${metadata.data ?? 'Parameter'} must be a valid UUID (received: "${value}")`,
      );
    }

    return value;
  }
}
