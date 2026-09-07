const validEnvironments = new Set(['development', 'test', 'production']);

export function validateEnvironment(config: Record<string, unknown>): Record<string, unknown> {
  const nodeEnv = String(config.NODE_ENV ?? 'development');
  const port = Number(config.PORT ?? 3000);
  const databaseUrl = String(config.DATABASE_URL ?? '');
  const jwtAccessSecret = String(config.JWT_ACCESS_SECRET ?? '');
  const jwtRefreshSecret = String(config.JWT_REFRESH_SECRET ?? '');
  const jwtAccessTtlSeconds = Number(config.JWT_ACCESS_TTL_SECONDS ?? 900);
  const jwtRefreshTtlSeconds = Number(config.JWT_REFRESH_TTL_SECONDS ?? 604_800);

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
  };
}
