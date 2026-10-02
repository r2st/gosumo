import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  BadRequestException,
} from '@nestjs/common';
import { validate as isUuid } from 'uuid';

@Injectable()
export class OptionalUuidPipe implements PipeTransform<string | undefined, string | undefined> {
  transform(value: string | undefined, metadata: ArgumentMetadata): string | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (!isUuid(value)) {
      throw new BadRequestException(
        `${metadata.data ?? 'Parameter'} must be a valid UUID (received: "${value}")`,
      );
    }

    return value;
  }
}
