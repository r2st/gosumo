/**
 * Variable declaration and interpolation for message templates.
 *
 * Deliberately the same `{{ name }}` syntax as `notification/template-renderer`,
 * and deliberately a separate implementation. The two render different things
 * for different audiences — that one renders a system notification against a
 * server-built data object, this one renders an agent's reply against values an
 * agent typed — and the behaviours they need at the boundary are opposites: an
 * unknown variable there renders empty and is reported, while here it must stop
 * the send. Sharing the renderer would mean one of the two silently getting the
 * other's rule.
 */

/** Matches `{{ name }}` with optional surrounding whitespace. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

/** Declared metadata for one `{{ variable }}` in a template body. */
export interface TemplateVariableSpec {
  /** The name as it appears between the braces. */
  name: string;
  /** Human label for the insert dialog. Defaults to the name. */
  label?: string;
  /** Whether the template refuses to render without it. */
  required: boolean;
  /** Value used when the agent supplies none. */
  defaultValue?: string;
}

/** Caller-supplied metadata for a variable. `name` picks which one it describes. */
export interface TemplateVariableInput {
  name: string;
  label?: string;
  required?: boolean;
  defaultValue?: string;
}

export interface RenderedTemplate {
  content: string;
  /** Required variables with no supplied value and no default. */
  missingRequired: string[];
  /** Variables filled from their declared default rather than the caller. */
  usedDefaults: string[];
}

/** Variable names referenced by a body, in first-appearance order, deduped. */
export function extractVariableNames(content: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of (content ?? '').matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

/**
 * Reconcile declared variable metadata against the body.
 *
 * The body is the authority. Metadata for a variable that is not in the content
 * is dropped, and a variable in the content with no metadata gets a required
 * default. Without this the two drift the first time somebody edits the body
 * without touching the variable list — and the drift is silent in the direction
 * that matters, leaving a required variable declared for a placeholder that no
 * longer exists while a newly added one is unlisted and so never prompted for.
 */
export function reconcileVariables(
  content: string,
  declared: readonly TemplateVariableInput[] = [],
): TemplateVariableSpec[] {
  const byName = new Map(declared.map((d) => [d.name, d]));

  return extractVariableNames(content).map((name) => {
    const spec = byName.get(name);
    return {
      name,
      // A variable is required unless it was explicitly declared otherwise.
      // The safe default is the one that stops a half-filled message reaching
      // a customer rather than the one that lets it through quietly.
      required: spec?.required ?? true,
      ...(spec?.label ? { label: spec.label } : {}),
      ...(spec?.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
    };
  });
}

/**
 * Interpolate a template body.
 *
 * An unsupplied optional variable renders as an empty string; an unsupplied
 * required one is reported in `missingRequired` and left as its placeholder, so
 * a caller that ignores the report ships something visibly broken rather than
 * something subtly wrong. `"Hi {{customerName}}, your refund of {{amount}}..."`
 * with a missing amount must not become `"your refund of ..."` — an empty
 * string there is a sentence the agent did not write and would not have sent.
 */
export function renderTemplate(
  content: string,
  values: Record<string, string | number | null | undefined> = {},
  specs: readonly TemplateVariableSpec[] = [],
): RenderedTemplate {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const missingRequired: string[] = [];
  const usedDefaults: string[] = [];

  const rendered = (content ?? '').replace(PLACEHOLDER, (placeholder, name: string) => {
    const supplied = values[name];
    if (supplied !== undefined && supplied !== null && String(supplied).length > 0) {
      return String(supplied);
    }

    const spec = byName.get(name);
    if (spec?.defaultValue !== undefined) {
      usedDefaults.push(name);
      return spec.defaultValue;
    }

    // Unknown variables — in the body but never declared — are treated as
    // required. They are the ones most likely to be a typo in the body, and a
    // typo that renders empty is invisible.
    if (spec === undefined || spec.required) {
      missingRequired.push(name);
      return placeholder;
    }
    return '';
  });

  return {
    content: rendered,
    missingRequired: [...new Set(missingRequired)],
    usedDefaults: [...new Set(usedDefaults)],
  };
}
