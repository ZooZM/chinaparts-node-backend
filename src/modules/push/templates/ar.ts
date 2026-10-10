import type { PushJobType } from '../push-sender';
import type { MessageText, TemplateValues } from './index';

/** Arabic is the default language (FR-065). */
export function render(type: PushJobType, values: TemplateValues): MessageText {
  const actor = values.actorName?.trim() || 'شخص ما';
  switch (type) {
    case 'newFollower':
      return { title: 'متابع جديد', body: `${actor} بدأ بمتابعتك` };
    case 'reelLike':
      return { title: 'إعجاب جديد', body: `${actor} أعجب بالريل الخاص بك` };
    case 'reelMention':
      return { title: 'تمت الإشارة إليك', body: `${actor} أشار إليك في ريل` };
    case 'reelRejected':
      return {
        title: 'تعذّر نشر الريل',
        body: 'لم يتم نشر الريل الخاص بك لأنه يخالف إرشادات المحتوى',
      };
  }
}
