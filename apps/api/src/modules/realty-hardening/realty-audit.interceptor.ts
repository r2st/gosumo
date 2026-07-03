import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import {
  RealtyOperationsAuditService,
  RealtyActorType,
} from './realty-operations-audit.service';
import { AUDITED_METHODS, REALTY_RESOURCE_TYPES } from './realty-hardening.constants';

interface AuthedRequest extends Request {
  tenantId?: string;
  user?: { sub?: string; businessId?: string; email?: string; role?: string };
}

/**
 * RealtyAuditInterceptor — automatic append-only audit for **every** mutating
 * realty HTTP operation (blueprint §21). Registered globally, it fires only for
 * `POST/PUT/PATCH/DELETE` requests whose path contains `realty/`, and only after
 * the handler succeeds (a 4xx/5xx throws and is not audited as a completed op).
 *
 * It writes actor, action, resource type/id, request id, IP, and user-agent —
 * best-effort, so an audit failure never affects the response. Services that
 * need before/after snapshots call {@link RealtyOperationsAuditService} directly.
 */
@Injectable()
export class RealtyAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: RealtyOperationsAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const method = (req.method ?? 'GET').toUpperCase();
    const path = req.path ?? req.url ?? '';

    if (!AUDITED_METHODS.has(method) || !this.isRealtyPath(path)) {
      return next.handle();
    }

    const businessId = req.tenantId ?? req.user?.businessId;
    // Without a tenant we cannot scope the audit row — skip (auth will 401 anyway).
    if (!businessId) return next.handle();

    return next.handle().pipe(
      tap((body) => {
        void this.audit.record({
          businessId,
          actorType: this.actorType(req),
          actorId: req.user?.sub ?? null,
          actorEmail: req.user?.email ?? null,
          action: RealtyOperationsAuditService.actionForMethod(method),
          resourceType: this.resourceType(path),
          resourceId: this.resourceId(path, body),
          requestId: this.requestId(req),
          ipAddress: this.ip(req),
          userAgent: req.headers?.['user-agent'] ?? null,
          description: `${method} ${path}`,
        });
      }),
    );
  }

  private isRealtyPath(path: string): boolean {
    return /(^|\/)realty\//.test(path);
  }

  private actorType(req: AuthedRequest): RealtyActorType {
    // An HTTP request authenticated with a team-member JWT is a human actor;
    // service-to-service / webhook calls without a subject are API actors.
    return req.user?.sub ? 'TEAM_MEMBER' : 'API';
  }

  /** Resolve `resource_type` from the segment right after `realty/`. */
  private resourceType(path: string): string {
    const seg = this.segmentAfterRealty(path);
    return (seg && REALTY_RESOURCE_TYPES[seg]) || (seg ? `realty_${seg}` : 'realty');
  }

  private segmentAfterRealty(path: string): string | null {
    const parts = path.split('/').filter(Boolean);
    const idx = parts.indexOf('realty');
    return idx >= 0 && parts[idx + 1] ? parts[idx + 1]! : null;
  }

  /** Prefer an id in the path; fall back to `body.id` for a fresh create. */
  private resourceId(path: string, body: unknown): string | null {
    const parts = path.split('/').filter(Boolean);
    const uuid = parts.find((p) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p),
    );
    if (uuid) return uuid;
    if (body && typeof body === 'object' && 'id' in body) {
      const id = (body as { id?: unknown }).id;
      return typeof id === 'string' ? id : null;
    }
    return null;
  }

  private requestId(req: AuthedRequest): string | null {
    const header = req.headers?.['x-correlation-id'] ?? req.headers?.['x-request-id'];
    if (Array.isArray(header)) return header[0] ?? null;
    return header ?? null;
  }

  private ip(req: AuthedRequest): string | null {
    const fwd = req.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0]!.trim();
    return req.ip ?? null;
  }
}
