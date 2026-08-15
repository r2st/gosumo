import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Module, Global } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';

/**
 * A connection pool is only a pool if the whole process shares one client.
 *
 * `PrismaService` was previously listed in the `providers` array of 39 feature
 * modules. Nest scopes a provider to the module that declares it, so that built
 * 39 separate `PrismaClient`s, each holding its own pool: 38 connections open
 * on an idle production API against a `max_connections=50` server shared with
 * another application, and 39 independently-growing pools under load.
 *
 * Nothing about that failure is loud — the app boots, every query works, and
 * the only symptom is connection count — so the regression guard here is
 * structural rather than behavioural.
 */
describe('PrismaModule', () => {
  const modulesRoot = join(__dirname, '..', '..', 'modules');

  function moduleFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...moduleFiles(full));
      else if (entry.endsWith('.module.ts')) out.push(full);
    }
    return out;
  }

  /**
   * Strip line and block comments so prose mentioning the class — the reason
   * a module is structured a certain way, say — is not read as a declaration.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('is the only place PrismaService is provided', () => {
    const offenders = moduleFiles(modulesRoot).filter((file) =>
      /\bPrismaService\b/.test(stripComments(readFileSync(file, 'utf8'))),
    );

    expect(offenders.map((f) => f.slice(modulesRoot.length + 1))).toEqual([]);
  });

  it('exports PrismaService', () => {
    const exports = Reflect.getMetadata('exports', PrismaModule) as unknown[];
    expect(exports).toContain(PrismaService);
  });

  it('is global, so feature modules inject it without importing anything', () => {
    // Nest marks @Global() modules with this metadata key; a plain @Module()
    // leaves it undefined, and every consumer would then need an explicit
    // import — the pressure that produced the per-module providers in the
    // first place.
    expect(Reflect.getMetadata('__module:global__', PrismaModule)).toBe(true);
  });

  it('hands two separate consumer modules the same instance', async () => {
    @Injectable()
    class AlphaRepository {
      constructor(readonly prisma: PrismaService) {}
    }

    @Injectable()
    class BetaRepository {
      constructor(readonly prisma: PrismaService) {}
    }

    @Module({ providers: [AlphaRepository], exports: [AlphaRepository] })
    class AlphaModule {}

    @Module({ providers: [BetaRepository], exports: [BetaRepository] })
    class BetaModule {}

    @Global()
    @Module({ imports: [PrismaModule, AlphaModule, BetaModule] })
    class RootModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [RootModule],
    }).compile();

    const alpha = moduleRef.get(AlphaRepository, { strict: false });
    const beta = moduleRef.get(BetaRepository, { strict: false });

    expect(alpha.prisma).toBe(beta.prisma);
    await moduleRef.close();
  });
});
