/** The files that let a domain open an app (research R15). Built from configuration, never stored. */

export interface IosAppLinkConfig {
  teamId: string;
  bundleId: string;
}

export interface AndroidAppLinkConfig {
  packageName: string;
  /** SHA-256 signing-certificate fingerprints, `AA:BB:...`. */
  fingerprints: string[];
}

/** `/.well-known/apple-app-site-association`: reel links open the customer app. */
export function buildAppleAppSiteAssociation(config: IosAppLinkConfig): object {
  const appId = `${config.teamId}.${config.bundleId}`;
  return {
    applinks: {
      details: [
        {
          // `appIDs` and `components` are the current form; `appID` and `paths` are what older iOS reads.
          appIDs: [appId],
          components: [{ '/': '/reels/*' }],
          appID: appId,
          paths: ['/reels/*'],
        },
      ],
    },
  };
}

/** `/.well-known/assetlinks.json`. */
export function buildAssetLinks(config: AndroidAppLinkConfig): object[] {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: config.packageName,
        sha256_cert_fingerprints: config.fingerprints,
      },
    },
  ];
}

/** The fingerprints setting is a comma-separated list. */
export function parseFingerprints(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
