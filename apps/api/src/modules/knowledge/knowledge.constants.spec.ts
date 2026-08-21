/**
 * Calibration of the AI retrieval floor against the index's weighting scheme.
 *
 * `AI_ARTICLE_SCORE_FLOOR` is a bare number whose correctness depends entirely
 * on the `setweight` labels in migration 0045 — and neither file mentions the
 * other at runtime. Raising the floor past 0.1, or reweighting the body above
 * D, silently narrows or widens what the AI is allowed to quote, with no test
 * failing and no log line saying so.
 *
 * The scores below are measured, not derived: with Postgres' default weights
 * {D,C,B,A} = {0.1, 0.2, 0.4, 1.0}, a single term hit scores 0.1 in the body
 * alone, 0.6 across keywords and summary, and 1.1 across title and body.
 */
import * as fs from 'fs';
import * as path from 'path';

import { AI_ARTICLE_SCORE_FLOOR, MAX_AI_ARTICLES } from './knowledge.constants';

/** Postgres' default `ts_rank_cd` weights, in the order setweight labels them. */
const WEIGHT = { A: 1.0, B: 0.4, C: 0.2, D: 0.1 } as const;

describe('AI_ARTICLE_SCORE_FLOOR', () => {
  it('admits an article that matches only in its body', () => {
    // A body mention is a real match. Excluding it would leave the answer
    // ungrounded on a question the business has actually documented.
    expect(AI_ARTICLE_SCORE_FLOOR).toBeLessThan(WEIGHT.D);
  });

  it('admits a match on the operator-supplied keywords', () => {
    // The `keywords` column exists precisely for the phrasings customers type
    // that the body never contains. A floor above B would make it inert.
    expect(AI_ARTICLE_SCORE_FLOOR).toBeLessThan(WEIGHT.B);
  });

  it('is above zero, so a non-matching row cannot be quoted as policy', () => {
    expect(AI_ARTICLE_SCORE_FLOOR).toBeGreaterThan(0);
  });

  it('keeps the prompt to a handful of whole articles', () => {
    // These are full articles, not the ~500-character chunks the vector store
    // returns, so the budget is small by design.
    expect(MAX_AI_ARTICLES).toBeGreaterThan(0);
    expect(MAX_AI_ARTICLES).toBeLessThanOrEqual(5);
  });
});

describe('the migration still weights the columns the floor assumes', () => {
  const migration = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../../../../packages/database/prisma/migrations/0045_knowledge_articles.sql',
    ),
    'utf8',
  );

  const fnBody = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION "knowledge_article_tsv"'),
    migration.indexOf('CREATE INDEX IF NOT EXISTS "knowledge_articles_search_idx"'),
  );

  it.each([
    ['title', '$1', 'A'],
    ['keywords', '$2', 'B'],
    ['summary', '$3', 'C'],
    ['body', '$4', 'D'],
  ])('weights %s at %s', (_column, param, weight) => {
    // One `setweight(...)` line per column; find the line carrying this
    // positional parameter and check the label it is stamped with.
    const line = fnBody
      .split('\n')
      .find((l) => l.includes('setweight(') && l.includes(param));

    expect(line).toBeDefined();
    expect(line).toContain(`), '${weight}'`);
  });
});
