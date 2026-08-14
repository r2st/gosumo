/**
 * `@IsSafeStorageKey()` / `@IsSafeFilename()` — the storage-key rules from
 * `common/utils/storage-key.util.ts`, as request-DTO decorators.
 *
 * The rules live in the util because the inbound-message path writes the same
 * column without ever seeing a DTO; these decorators exist so a bad key is
 * rejected at the boundary with a 400 that names the field, rather than
 * further in where the only honest answer is a 500.
 */

import {
  ValidationOptions,
  buildMessage,
  registerDecorator,
} from 'class-validator';

import { isSafeFilename, isSafeStorageKey } from '../utils/storage-key.util';

export function IsSafeStorageKey(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isSafeStorageKey',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => isSafeStorageKey(value),
        defaultMessage: buildMessage(
          (prefix) =>
            `${prefix}$property must be a relative object key — no scheme, ` +
            `leading slash, ".." segment, backslash, or control character`,
          validationOptions,
        ),
      },
    });
  };
}

export function IsSafeFilename(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isSafeFilename',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => isSafeFilename(value),
        defaultMessage: buildMessage(
          (prefix) =>
            `${prefix}$property must be a single filename — no path separator ` +
            `or control character`,
          validationOptions,
        ),
      },
    });
  };
}
