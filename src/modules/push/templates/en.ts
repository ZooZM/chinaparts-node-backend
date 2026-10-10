import type { PushJobType } from '../push-sender';
import type { MessageText, TemplateValues } from './index';

export function render(type: PushJobType, values: TemplateValues): MessageText {
  const actor = values.actorName?.trim() || 'Someone';
  switch (type) {
    case 'newFollower':
      return { title: 'New follower', body: `${actor} started following you` };
    case 'reelLike':
      return { title: 'New like', body: `${actor} liked your reel` };
    case 'reelMention':
      return {
        title: 'You were mentioned',
        body: `${actor} mentioned you in a reel`,
      };
    case 'reelRejected':
      return {
        title: "Your reel wasn't published",
        body: "Your reel wasn't published because it goes against the content guidelines",
      };
  }
}
