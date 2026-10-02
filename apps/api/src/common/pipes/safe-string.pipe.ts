import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  BadRequestException,
} from '@nestjs/common';

/**
 * SafeStringPipe — validates that a path parameter is a non-empty string
 * matching `^[a-zA-Z0-9_-]+$` and within a max length.
 *
 * Use for non-UUID string params (provider names, slugs, shortcodes) where
 * the value is caller-supplied and used in lookups or log lines.
 */
@Injectable()
export class SafeStringPipe implements PipeTransform<string, string> {
  private static readonly PATTERN = /^[a-zA-Z0-9_-]+$/;
  private readonly maxLength: number;

  constructor(maxLength = 100) {
    this.maxLength = maxLength;
  }

  transform(value: string, metadata: ArgumentMetadata): string {
    if (!value) {
      throw new BadRequestException(
        `${metadata.data ?? 'Parameter'} is required`,
      );
    }

    if (value.length > this.maxLength) {
      throw new BadRequestException(
        `${metadata.data ?? 'Parameter'} must be at most ${this.maxLength} characters`,
      );
    }

    if (!SafeStringPipe.PATTERN.test(value)) {
      throw new BadRequestException(
        `${metadata.data ?? 'Parameter'} contains invalid characters (allowed: letters, digits, hyphens, underscores)`,
      );
    }

    return value;
  }
}
