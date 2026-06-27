import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../interceptors/tenant.interceptor';

/**
 * @Public() — marks a route handler or entire controller as publicly
 * accessible, bypassing JwtAuthGuard and TenantInterceptor.
 *
 * Usage:
 *   @Public()
 *   @Get('health')
 *   health() { return { status: 'ok' }; }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
