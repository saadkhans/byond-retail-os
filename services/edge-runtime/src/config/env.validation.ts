import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * Edge runtime configuration, validated at boot.
 *
 * Two rules shape this file:
 * - Values are never echoed in an error. `EDGE_CLOUD_TOKEN` is a credential
 *   and `EDGE_CLOUD_BASE_URL` can carry one, so failures report property
 *   names only.
 * - Transport security is not a preference. Outside development the cloud
 *   URL must be https; http is tolerated only for loopback while developing.
 */
export class EdgeEnvironmentVariables {
  @IsOptional()
  @IsEnum(NodeEnv)
  NODE_ENV?: NodeEnv;

  @IsString()
  @MinLength(1)
  EDGE_TENANT_ID!: string;

  @IsString()
  @MinLength(1)
  EDGE_LOCATION_ID!: string;

  @IsString()
  @MinLength(1)
  EDGE_DEVICE_ID!: string;

  @IsString()
  @MinLength(1)
  EDGE_STORE_ROOT!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  EDGE_CLOUD_BASE_URL?: string;

  @IsOptional()
  @IsString()
  @MinLength(16)
  EDGE_CLOUD_TOKEN?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(3_600_000)
  EDGE_SYNC_INTERVAL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  EDGE_SYNC_BATCH_SIZE?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  EDGE_SYNC_MAX_ATTEMPTS?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(600_000)
  EDGE_SYNC_BACKOFF_BASE_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(86_400_000)
  EDGE_SYNC_BACKOFF_MAX_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(1_000_000)
  EDGE_OUTBOX_MAX_ENTRIES?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  EDGE_REVIEW_CONFIDENCE_THRESHOLD?: number;

  @IsOptional()
  @Matches(/^[a-z]+:[a-z0-9-]+(,[a-z]+:[a-z0-9-]+)*$/, {
    message:
      'EDGE_DRIVERS must be a comma-separated list of kind:adapterKey ' +
      'pairs, e.g. camera:simulated,scale:simulated',
  })
  EDGE_DRIVERS?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(3_600_000)
  EDGE_HEARTBEAT_INTERVAL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  EDGE_OPS_PORT?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  EDGE_OPS_BIND_ADDRESS?: string;
}

/**
 * TLS is mandatory for the control-plane connection. Loopback http is allowed
 * only while NODE_ENV is explicitly development or test, so a production node
 * cannot be pointed at a plaintext endpoint by configuration alone.
 */
export function assertCloudUrlSecure(
  rawUrl: string | undefined,
  nodeEnv: NodeEnv | undefined,
): void {
  if (rawUrl === undefined) {
    return;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Never echo the value: it can carry credentials in its userinfo.
    throw new Error('Invalid environment configuration: EDGE_CLOUD_BASE_URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      'EDGE_CLOUD_BASE_URL must not embed credentials; use EDGE_CLOUD_TOKEN',
    );
  }
  if (url.protocol === 'https:') {
    return;
  }
  if (url.protocol !== 'http:') {
    throw new Error('EDGE_CLOUD_BASE_URL must use https');
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  const developing =
    nodeEnv === NodeEnv.Development || nodeEnv === NodeEnv.Test;
  if (loopback && developing) {
    return;
  }
  throw new Error(
    'EDGE_CLOUD_BASE_URL must use https; plaintext http is accepted only ' +
      'for loopback while NODE_ENV is development or test',
  );
}

/** A configured cloud URL without a token can never authenticate — fail fast. */
export function assertCloudCredentialsComplete(
  baseUrl: string | undefined,
  token: string | undefined,
): void {
  if (baseUrl !== undefined && token === undefined) {
    throw new Error(
      'EDGE_CLOUD_BASE_URL is set without EDGE_CLOUD_TOKEN; the edge node ' +
        'would run permanently unauthenticated',
    );
  }
}

export function validateEdgeEnv(
  config: Record<string, unknown>,
): EdgeEnvironmentVariables {
  const validated = plainToInstance(EdgeEnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: true,
  });
  if (errors.length > 0) {
    const properties = errors.map((error) => error.property).join(', ');
    throw new Error(`Invalid environment configuration: ${properties}`);
  }
  assertCloudUrlSecure(validated.EDGE_CLOUD_BASE_URL, validated.NODE_ENV);
  assertCloudCredentialsComplete(
    validated.EDGE_CLOUD_BASE_URL,
    validated.EDGE_CLOUD_TOKEN,
  );
  return validated;
}
