import { S3Client } from '@aws-sdk/client-s3';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalStorageDriver } from './drivers/local.driver';
import { S3StorageDriver } from './drivers/s3.driver';
import {
  STORAGE_DRIVER,
  StorageDriver,
  StorageService,
} from './storage.service';

function createS3Driver(config: ConfigService): S3StorageDriver {
  const clientConfig = {
    region: config.get<string>('S3_REGION'),
    credentials: {
      accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
      secretAccessKey: config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
    },
    // MinIO and Google Cloud Storage's S3 API both want path-style addressing.
    forcePathStyle: true,
  };
  const client = new S3Client({
    ...clientConfig,
    endpoint: config.getOrThrow<string>('S3_ENDPOINT'),
  });
  const presignEndpoint = config.get<string>('S3_PRESIGN_ENDPOINT');
  const presignClient = presignEndpoint
    ? new S3Client({ ...clientConfig, endpoint: presignEndpoint })
    : client;
  return new S3StorageDriver(client, presignClient);
}

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_DRIVER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageDriver =>
        config.get<string>('STORAGE_DRIVER') === 's3'
          ? createS3Driver(config)
          : new LocalStorageDriver(
              config.get<string>('STORAGE_LOCAL_DIR') || './.local-media',
            ),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
