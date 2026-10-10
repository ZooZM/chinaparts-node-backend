import { ACCESS_KEY } from '../../common/guards/access.decorator';
import { user } from '../../common/guards/testing';
import { AccountsController } from './accounts.controller';
import type { AccountsService, MeDto } from './accounts.service';

const me: MeDto = {
  id: '650000000000000000000001',
  accountType: 'seller',
  username: 'Ahmed_Salem',
  name: 'Ahmed Salem',
  avatarUrl: null,
  bio: '',
  locale: 'ar',
  followersCount: 3,
  followingCount: 2,
  totalLikes: 7,
};

describe('AccountsController', () => {
  it("answers with the caller's own account, looked up by their reels id", async () => {
    const getMe = jest.fn<Promise<MeDto>, [string]>().mockResolvedValue(me);
    const controller = new AccountsController({
      getMe,
    } as unknown as AccountsService);

    await expect(
      controller.getMe(user({ userId: me.id, accountType: 'seller' })),
    ).resolves.toBe(me);
    expect(getMe).toHaveBeenCalledWith(me.id);
  });

  it('needs a session (EP24)', () => {
    const handler = Object.getOwnPropertyDescriptor(
      AccountsController.prototype,
      'getMe',
    )?.value as (...args: never[]) => unknown;
    expect(Reflect.getMetadata(ACCESS_KEY, handler)).toBe('signed-in');
  });

  it('changes the handle and bio of the caller only (EP25), and needs a session', async () => {
    const updateMe = jest
      .fn<Promise<MeDto>, [string, { username?: string; bio?: string }]>()
      .mockResolvedValue(me);
    const controller = new AccountsController({
      updateMe,
    } as unknown as AccountsService);

    await expect(
      controller.updateMe(user({ userId: me.id }), { username: 'new.handle' }),
    ).resolves.toBe(me);

    expect(updateMe).toHaveBeenCalledWith(me.id, { username: 'new.handle' });
    const handler = Object.getOwnPropertyDescriptor(
      AccountsController.prototype,
      'updateMe',
    )?.value as (...args: never[]) => unknown;
    expect(Reflect.getMetadata(ACCESS_KEY, handler)).toBe('signed-in');
  });
});
