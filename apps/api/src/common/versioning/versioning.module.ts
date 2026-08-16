import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DeprecationInterceptor } from './deprecation.interceptor';

/**
 * VersioningModule — the API's deprecation signalling.
 *
 * Global and entirely opt-in: without an `@ApiDeprecated()` on the handler or
 * its controller the interceptor returns before touching the response, so
 * registering it changes nothing for the ~200 routes that are not deprecated.
 *
 * Registered as an `APP_INTERCEPTOR` rather than applied per controller so
 * that deprecating a route is a one-line decorator and never a second edit
 * somebody forgets — which is the failure mode that leaves an endpoint marked
 * deprecated in the docs and silent on the wire.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: DeprecationInterceptor,
    },
  ],
})
export class VersioningModule {}
