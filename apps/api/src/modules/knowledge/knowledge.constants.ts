/**
 * Bounds and tuning for the PostgreSQL-backed knowledge base.
 */

/** Largest body an article may carry, in characters. */
export const MAX_ARTICLE_BODY_LENGTH = 20_000;

/** Largest summary an article may carry, in characters. */
export const MAX_ARTICLE_SUMMARY_LENGTH = 2_000;

/** Most tags / keywords / applicable intents one article may declare. */
export const MAX_ARTICLE_TAGS = 20;
export const MAX_ARTICLE_KEYWORDS = 30;

/**
 * How many articles the AI retrieval path may pull into one prompt.
 *
 * Small on purpose. These are whole articles rather than the ~500-character
 * chunks the vector store returns, so three of them is already a substantial
 * share of the prompt, and the confidence calculator treats "has grounding" as
 * a boolean rather than scaling with count.
 */
export const MAX_AI_ARTICLES = 3;

/**
 * Minimum `ts_rank_cd` score an article must reach to ground an answer.
 *
 * Retrieval that returns a weak match is worse than returning nothing: the
 * prompt presents whatever comes back as the business's own policy, so a
 * loosely-related article makes the model answer confidently off the wrong
 * document. Operator-facing search has no floor — a human can see that a
 * result is irrelevant and ignore it.
 *
 * The value is calibrated against the `setweight` scheme in migration 0045,
 * measured against Postgres rather than reasoned about. With the default
 * weights {D,C,B,A} = {0.1, 0.2, 0.4, 1.0}, one term hit scores 0.1 in the body
 * alone, 0.6 in keywords-plus-summary, and 1.1 in title-plus-body.
 *
 * So the floor sits *below* a lone body hit, deliberately: an article whose
 * body discusses the topic is a real match, and dropping it would leave the
 * answer ungrounded on a question the business has in fact documented. What it
 * excludes is the near-zero tail `ts_rank_cd` produces when a multi-term query
 * matches a long article only diffusely — a document that shares vocabulary
 * with the question without being about it, which is exactly the hit that
 * makes the model answer confidently off the wrong page.
 *
 * `knowledge.constants.spec.ts` pins the 0.1 relationship, so raising the
 * floor past a body-only match fails rather than quietly narrowing retrieval.
 */
export const AI_ARTICLE_SCORE_FLOOR = 0.05;

/**
 * Characters of `body` used as the prompt excerpt when an article has no
 * `summary`. Long enough to carry a policy, short enough that three of them
 * do not crowd out the conversation history.
 */
export const ARTICLE_EXCERPT_LENGTH = 800;

/** Longest slug that can be derived from a title. */
export const MAX_SLUG_LENGTH = 160;
