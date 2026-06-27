import { Injectable } from '@nestjs/common';

/**
 * Channel-agnostic template body. Stored on a notification_template's `content`
 * column. Each channel reads the fields relevant to it:
 *  - EMAIL: subject + html/text
 *  - SMS:   text
 *  - PUSH:  title + text
 *  - WHATSAPP: text (free-form) or external_name (approved template) + params
 */
export interface TemplateContent {
  subject?: string;
  title?: string;
  /** Plain-text body — the primary field, used by SMS/PUSH/WhatsApp. */
  text?: string;
  /** Optional rich HTML body for email. */
  html?: string;
}

/**
 * Result of rendering a template against a data context.
 */
export interface RenderedContent {
  subject: string | null;
  title: string | null;
  text: string;
  html: string | null;
  /** Variable names referenced by the template but missing from the data. */
  missingVariables: string[];
}

/** Matches `{{ path.to.value }}` with optional surrounding whitespace. */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * TemplateRenderer — pure, deterministic Mustache-lite renderer.
 *
 * Substitutes `{{ variable }}` (dot-path supported) placeholders with values
 * from a data object. Unknown variables render as an empty string and are
 * reported in `missingVariables` so callers can decide whether to proceed.
 */
@Injectable()
export class TemplateRenderer {
  /**
   * Render a full template content object against `data`.
   */
  render(content: TemplateContent, data: Record<string, unknown>): RenderedContent {
    const missing = new Set<string>();

    const sub = (input: string | undefined | null): string | null => {
      if (input == null) {
        return null;
      }
      return input.replace(PLACEHOLDER, (_match, path: string) => {
        const value = this.resolvePath(data, path);
        if (value === undefined || value === null) {
          missing.add(path);
          return '';
        }
        return String(value);
      });
    };

    return {
      subject: sub(content.subject),
      title: sub(content.title),
      text: sub(content.text) ?? '',
      html: sub(content.html),
      missingVariables: [...missing],
    };
  }

  /**
   * Render a single string (used for ad-hoc bodies that aren't full templates).
   */
  renderString(input: string, data: Record<string, unknown>): string {
    return input.replace(PLACEHOLDER, (_match, path: string) => {
      const value = this.resolvePath(data, path);
      return value === undefined || value === null ? '' : String(value);
    });
  }

  /**
   * Extract the list of `{{ variable }}` names referenced by a template.
   * Used to validate/preview a template against the data it expects.
   */
  extractVariables(content: TemplateContent): string[] {
    const found = new Set<string>();
    for (const field of [content.subject, content.title, content.text, content.html]) {
      if (!field) continue;
      for (const match of field.matchAll(PLACEHOLDER)) {
        found.add(match[1]!);
      }
    }
    return [...found];
  }

  /** Resolve a dot-path (`a.b.c`) against a nested object. */
  private resolvePath(data: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
      if (acc != null && typeof acc === 'object' && key in (acc as object)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, data);
  }
}
