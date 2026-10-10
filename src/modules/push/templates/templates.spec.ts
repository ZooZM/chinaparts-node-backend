import type { PushJobType } from '../push-sender';
import { render as renderAr } from './ar';
import { render as renderEn } from './en';
import { renderMessage } from './index';

const TYPES: PushJobType[] = [
  'newFollower',
  'reelLike',
  'reelMention',
  'reelRejected',
];

describe('push templates (FR-065)', () => {
  it.each(TYPES)('%s has a title and a body in both languages', (type) => {
    for (const render of [renderAr, renderEn]) {
      const text = render(type, { actorName: 'Sara K.' });
      expect(text.title.length).toBeGreaterThan(0);
      expect(text.body.length).toBeGreaterThan(0);
    }
  });

  it('names the actor in the notifications that have one', () => {
    for (const type of ['newFollower', 'reelLike', 'reelMention'] as const) {
      expect(renderAr(type, { actorName: 'Sara K.' }).body).toContain(
        'Sara K.',
      );
      expect(renderEn(type, { actorName: 'Sara K.' }).body).toContain(
        'Sara K.',
      );
    }
  });

  it('does not name anyone in a rejection, which has no actor', () => {
    expect(
      renderAr('reelRejected', { actorName: 'Sara K.' }).body,
    ).not.toContain('Sara');
    expect(
      renderEn('reelRejected', { actorName: 'Sara K.' }).body,
    ).not.toContain('Sara');
  });

  it('says "someone" when the actor has no name', () => {
    expect(renderEn('reelLike', {}).body).toContain('Someone');
    expect(renderAr('reelLike', {}).body).toContain('شخص ما');
    expect(renderEn('reelLike', { actorName: '   ' }).body).toContain(
      'Someone',
    );
  });

  it('writes Arabic as Arabic and English as English', () => {
    expect(renderAr('reelLike', { actorName: 'x' }).title).toMatch(/[؀-ۿ]/);
    expect(renderEn('reelLike', { actorName: 'x' }).title).not.toMatch(/[؀-ۿ]/);
  });

  describe('renderMessage', () => {
    it("picks the recipient's language", () => {
      expect(renderMessage('en', 'newFollower', { actorName: 'A' }).title).toBe(
        'New follower',
      );
      expect(renderMessage('ar', 'newFollower', { actorName: 'A' }).title).toBe(
        'متابع جديد',
      );
    });

    it.each([undefined, '', 'fr', 'AR-SA'])(
      'defaults to Arabic for %p',
      (locale) => {
        expect(
          renderMessage(locale, 'newFollower', { actorName: 'A' }).title,
        ).toBe('متابع جديد');
      },
    );
  });
});
