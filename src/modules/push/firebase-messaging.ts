import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { AccountType } from '../../common/http/viewer-request';
import type { PushMessage } from './push-payload.builder';

/** Injection token for the connection to Firebase. Tests replace it with one that captures. */
export const FIREBASE_MESSAGING = Symbol('FIREBASE_MESSAGING');

export interface MulticastRequest extends PushMessage {
  tokens: string[];
}

/** One answer per token, in the order they were sent. */
export interface MulticastOutcome {
  responses: Array<{ success: boolean; errorCode?: string }>;
}

/** All the service needs from Firebase, so the rest of the code never sees `firebase-admin`. */
export interface FirebaseMessaging {
  sendEachForMulticast(
    app: AccountType,
    request: MulticastRequest,
  ): Promise<MulticastOutcome>;
}

const CREDENTIAL_KEYS: Record<AccountType, string> = {
  customer: 'FCM_CUSTOMER_CREDENTIALS_JSON',
  seller: 'FCM_SELLER_CREDENTIALS_JSON',
};

/**
 * Firebase through `firebase-admin`, with one app per China Parts app because the customer app and
 * the seller app may live in separate Firebase projects (research R14). An app whose credentials
 * are empty simply sends nothing, with a warning once, so a development environment needs no
 * Firebase account.
 */
@Injectable()
export class FirebaseAdminMessaging
  implements FirebaseMessaging, OnApplicationShutdown
{
  private readonly logger = new Logger(FirebaseAdminMessaging.name);
  private readonly apps = new Map<AccountType, App | null>();

  constructor(private readonly config: ConfigService) {}

  async sendEachForMulticast(
    accountType: AccountType,
    request: MulticastRequest,
  ): Promise<MulticastOutcome> {
    const app = this.appFor(accountType);
    if (!app) return { responses: [] };
    const result = await getMessaging(app).sendEachForMulticast(request);
    return {
      responses: result.responses.map((response) => ({
        success: response.success,
        errorCode: response.error?.code,
      })),
    };
  }

  private appFor(accountType: AccountType): App | null {
    const known = this.apps.get(accountType);
    if (known !== undefined) return known;

    const credentials = (
      this.config.get<string>(CREDENTIAL_KEYS[accountType]) ?? ''
    ).trim();
    if (credentials === '') {
      this.logger.warn(
        `No Firebase credentials for the ${accountType} app: its pushes are not sent`,
      );
      this.apps.set(accountType, null);
      return null;
    }
    const app = initializeApp(
      { credential: cert(JSON.parse(credentials) as Record<string, string>) },
      `reels-${accountType}`,
    );
    this.apps.set(accountType, app);
    return app;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      [...this.apps.values()]
        .filter((app): app is App => app !== null)
        .map((app) => deleteApp(app)),
    );
  }
}
