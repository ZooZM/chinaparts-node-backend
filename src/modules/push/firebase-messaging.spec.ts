import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { FirebaseAdminMessaging } from './firebase-messaging';
import type { MulticastRequest } from './firebase-messaging';
import { PushPayloadBuilder } from './push-payload.builder';

jest.mock('firebase-admin/app', () => ({
  cert: jest.fn((credentials: unknown) => ({ credentials })),
  initializeApp: jest.fn((options: unknown, name: string) => ({
    options,
    name,
  })),
  deleteApp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));

const message = new PushPayloadBuilder().build(
  { type: 'reelLike', recipientId: 'r', actorId: 'a', reelId: 'x' },
  'en',
  'Sara K.',
  0,
);
const request: MulticastRequest = { ...message, tokens: ['t1', 't2'] };

function setup(values: Record<string, string | undefined>) {
  const sendEachForMulticast = jest.fn().mockResolvedValue({
    responses: [
      { success: true },
      {
        success: false,
        error: { code: 'messaging/registration-token-not-registered' },
      },
    ],
  });
  (getMessaging as jest.Mock).mockReturnValue({ sendEachForMulticast });
  const gateway = new FirebaseAdminMessaging({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
  return { gateway, sendEachForMulticast };
}

const CREDENTIALS = JSON.stringify({
  project_id: 'china-parts',
  private_key: 'k',
});

describe('FirebaseAdminMessaging (research R14)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends nothing for an app with no credentials, and says so once', async () => {
    const { gateway, sendEachForMulticast } = setup({});

    expect(await gateway.sendEachForMulticast('customer', request)).toEqual({
      responses: [],
    });
    expect(await gateway.sendEachForMulticast('customer', request)).toEqual({
      responses: [],
    });

    expect(initializeApp).not.toHaveBeenCalled();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('customer'));
  });

  it('treats blank credentials as none', async () => {
    const { gateway } = setup({ FCM_SELLER_CREDENTIALS_JSON: '   ' });
    expect(await gateway.sendEachForMulticast('seller', request)).toEqual({
      responses: [],
    });
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it('starts one Firebase app per China Parts app, from its own credentials, once', async () => {
    const { gateway } = setup({
      FCM_CUSTOMER_CREDENTIALS_JSON: CREDENTIALS,
      FCM_SELLER_CREDENTIALS_JSON: CREDENTIALS,
    });

    await gateway.sendEachForMulticast('customer', request);
    await gateway.sendEachForMulticast('customer', request);
    await gateway.sendEachForMulticast('seller', request);

    expect(initializeApp).toHaveBeenCalledTimes(2);
    expect(
      (initializeApp as jest.Mock).mock.calls.map((call: unknown[]) => call[1]),
    ).toEqual(['reels-customer', 'reels-seller']);
    expect(cert).toHaveBeenCalledWith({
      project_id: 'china-parts',
      private_key: 'k',
    });
  });

  it('sends the request to Firebase, and answers with success and error code for each token', async () => {
    const { gateway, sendEachForMulticast } = setup({
      FCM_SELLER_CREDENTIALS_JSON: CREDENTIALS,
    });

    const outcome = await gateway.sendEachForMulticast('seller', request);

    expect(sendEachForMulticast).toHaveBeenCalledWith(request);
    expect(outcome.responses).toEqual([
      { success: true, errorCode: undefined },
      {
        success: false,
        errorCode: 'messaging/registration-token-not-registered',
      },
    ]);
  });

  it('closes its apps when the application stops', async () => {
    const { gateway } = setup({ FCM_SELLER_CREDENTIALS_JSON: CREDENTIALS });
    await gateway.sendEachForMulticast('seller', request);
    await gateway.sendEachForMulticast('customer', request); // no credentials: no app

    await gateway.onApplicationShutdown();

    expect(deleteApp).toHaveBeenCalledTimes(1);
  });
});
