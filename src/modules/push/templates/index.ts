import type { PushJobType } from '../push-sender';
import { render as renderAr } from './ar';
import { render as renderEn } from './en';

/** What a push says: the title and the body, in one language. */
export interface MessageText {
  title: string;
  body: string;
}

/** The only value a message may carry from the person who caused it: their public name. */
export interface TemplateValues {
  actorName?: string;
}

/**
 * The words of a push in the recipient's language. Arabic is the default for any locale it does
 * not know (FR-065), because China Parts' customers are Arabic-first.
 */
export function renderMessage(
  locale: string | undefined,
  type: PushJobType,
  values: TemplateValues = {},
): MessageText {
  return locale === 'en' ? renderEn(type, values) : renderAr(type, values);
}
