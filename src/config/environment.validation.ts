const validEnvironments = new Set(['development', 'test', 'production']);

export function validateEnvironment(config: Record<string, unknown>): Record<string, unknown> {
  const nodeEnv = String(config.NODE_ENV ?? 'development');
  const port = Number(config.PORT ?? 3000);
  const databaseUrl = String(config.DATABASE_URL ?? '');
  const jwtAccessSecret = String(config.JWT_ACCESS_SECRET ?? '');
  const jwtRefreshSecret = String(config.JWT_REFRESH_SECRET ?? '');
  const jwtAccessTtlSeconds = Number(config.JWT_ACCESS_TTL_SECONDS ?? 900);
  const jwtRefreshTtlSeconds = Number(config.JWT_REFRESH_TTL_SECONDS ?? 604_800);
  const swaggerEnabledValue = String(
    config.SWAGGER_ENABLED ?? (nodeEnv === 'production' ? 'false' : 'true'),
  ).toLowerCase();
  const operationsDefaultPageSize = Number(config.OPERATIONS_DEFAULT_PAGE_SIZE ?? 20);
  const operationsMaxPageSize = Number(config.OPERATIONS_MAX_PAGE_SIZE ?? 100);
  const operationsMaxItemsPerOrder = Number(config.OPERATIONS_MAX_ITEMS_PER_ORDER ?? 50);
  const servingTaskClaimTimeoutSeconds = Number(config.SERVING_TASK_CLAIM_TIMEOUT_SECONDS ?? 300);
  const invoiceNumberPrefix = String(config.INVOICE_NUMBER_PREFIX ?? 'INV').trim();
  const realtimeEnabledValue = String(config.REALTIME_ENABLED ?? 'true').toLowerCase();
  const realtimePath = `/${String(config.REALTIME_PATH ?? 'socket.io').replace(/^\/+|\/+$/g, '')}`;
  const realtimeCorsOrigins = String(config.REALTIME_CORS_ORIGINS ?? '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!validEnvironments.has(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  if (!databaseUrl.startsWith('postgresql://') && !databaseUrl.startsWith('postgres://')) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }

  if (jwtAccessSecret.length < 32 || jwtRefreshSecret.length < 32) {
    throw new Error('JWT access and refresh secrets must each contain at least 32 characters.');
  }

  if (jwtAccessSecret === jwtRefreshSecret) {
    throw new Error('JWT access and refresh secrets must be different.');
  }

  if (!Number.isInteger(jwtAccessTtlSeconds) || jwtAccessTtlSeconds < 60) {
    throw new Error('JWT_ACCESS_TTL_SECONDS must be an integer of at least 60.');
  }

  if (!Number.isInteger(jwtRefreshTtlSeconds) || jwtRefreshTtlSeconds <= jwtAccessTtlSeconds) {
    throw new Error('JWT_REFRESH_TTL_SECONDS must be longer than the access token TTL.');
  }

  if (swaggerEnabledValue !== 'true' && swaggerEnabledValue !== 'false') {
    throw new Error('SWAGGER_ENABLED must be true or false.');
  }

  const swaggerPath = String(config.SWAGGER_PATH ?? 'api/docs').replace(/^\/+|\/+$/g, '');

  if (!swaggerPath) {
    throw new Error('SWAGGER_PATH must not be empty.');
  }

  const positiveIntegers = {
    OPERATIONS_DEFAULT_PAGE_SIZE: operationsDefaultPageSize,
    OPERATIONS_MAX_PAGE_SIZE: operationsMaxPageSize,
    OPERATIONS_MAX_ITEMS_PER_ORDER: operationsMaxItemsPerOrder,
    SERVING_TASK_CLAIM_TIMEOUT_SECONDS: servingTaskClaimTimeoutSeconds,
  };
  for (const [name, value] of Object.entries(positiveIntegers)) {
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`${name} must be a positive integer.`);
  }
  if (operationsDefaultPageSize > operationsMaxPageSize) {
    throw new Error('OPERATIONS_DEFAULT_PAGE_SIZE must not exceed OPERATIONS_MAX_PAGE_SIZE.');
  }
  if (!/^[A-Z0-9-]{1,12}$/.test(invoiceNumberPrefix)) {
    throw new Error(
      'INVOICE_NUMBER_PREFIX must contain 1-12 uppercase letters, numbers, or dashes.',
    );
  }
  if (realtimeEnabledValue !== 'true' && realtimeEnabledValue !== 'false') {
    throw new Error('REALTIME_ENABLED must be true or false.');
  }
  if (realtimeCorsOrigins.length === 0) {
    throw new Error('REALTIME_CORS_ORIGINS must contain at least one origin or *.');
  }

  return {
    ...config,
    NODE_ENV: nodeEnv,
    PORT: port,
    API_PREFIX: String(config.API_PREFIX ?? 'api/v1').replace(/^\/+|\/+$/g, ''),
    DATABASE_URL: databaseUrl,
    JWT_ACCESS_SECRET: jwtAccessSecret,
    JWT_REFRESH_SECRET: jwtRefreshSecret,
    JWT_ACCESS_TTL_SECONDS: jwtAccessTtlSeconds,
    JWT_REFRESH_TTL_SECONDS: jwtRefreshTtlSeconds,
    JWT_ISSUER: String(config.JWT_ISSUER ?? 'smart-fnb-backend'),
    JWT_AUDIENCE: String(config.JWT_AUDIENCE ?? 'smart-fnb-client'),
    SWAGGER_ENABLED: swaggerEnabledValue === 'true',
    SWAGGER_PATH: swaggerPath,
    OPERATIONS_DEFAULT_PAGE_SIZE: operationsDefaultPageSize,
    OPERATIONS_MAX_PAGE_SIZE: operationsMaxPageSize,
    OPERATIONS_MAX_ITEMS_PER_ORDER: operationsMaxItemsPerOrder,
    SERVING_TASK_CLAIM_TIMEOUT_SECONDS: servingTaskClaimTimeoutSeconds,
    INVOICE_NUMBER_PREFIX: invoiceNumberPrefix,
    REALTIME_ENABLED: realtimeEnabledValue === 'true',
    REALTIME_PATH: realtimePath,
    REALTIME_CORS_ORIGINS: realtimeCorsOrigins,
  };
}
