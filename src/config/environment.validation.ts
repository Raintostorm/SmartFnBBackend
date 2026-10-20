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
  const payosMasterKey = String(config.PAYOS_MASTER_KEY ?? '').trim();
  const payosWebhookBaseUrl = String(config.PAYOS_WEBHOOK_BASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const publicWebUrl = String(
    config.PUBLIC_WEB_URL || config.FRONTEND_URL || 'http://localhost:8443',
  )
    .trim()
    .replace(/\/+$/, '');
  const orderTrackingSecret = String(config.ORDER_TRACKING_SECRET ?? '').trim();
  const emailProvider = String(config.EMAIL_PROVIDER ?? 'resend')
    .trim()
    .toLowerCase();
  const emailApiKey = String(config.EMAIL_API_KEY || config.RESEND_API_KEY || '').trim();
  const emailFrom = String(
    config.EMAIL_FROM ||
      config.RESEND_FROM_EMAIL ||
      (emailApiKey ? 'Smart FnB <no-reply@mail.smartfnb.tech>' : ''),
  ).trim();
  const paymentExpiryJobEnabledValue = String(
    config.PAYMENT_EXPIRY_JOB_ENABLED ?? 'true',
  ).toLowerCase();
  const paymentExpiryJobIntervalMs = Number(config.PAYMENT_EXPIRY_JOB_INTERVAL_MS ?? 60_000);
  const paymentExpiryBatchSize = Number(config.PAYMENT_EXPIRY_BATCH_SIZE ?? 100);
  const receiptPdfEnabledValue = String(
    config.RECEIPT_PDF_ENABLED ?? (nodeEnv === 'production' ? 'false' : 'true'),
  ).toLowerCase();
  const receiptStorageProvider = String(config.RECEIPT_STORAGE_PROVIDER ?? 'local').toLowerCase();
  const assetStorageProvider = String(config.ASSET_STORAGE_PROVIDER ?? 'local').toLowerCase();

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
  if (payosMasterKey && Buffer.from(payosMasterKey, 'base64').length !== 32) {
    throw new Error('PAYOS_MASTER_KEY must be a base64-encoded 32-byte key.');
  }
  if (payosWebhookBaseUrl && !/^https?:\/\//.test(payosWebhookBaseUrl)) {
    throw new Error('PAYOS_WEBHOOK_BASE_URL must be an absolute HTTP(S) URL.');
  }
  if (!/^https?:\/\//.test(publicWebUrl)) {
    throw new Error('PUBLIC_WEB_URL must be an absolute HTTP(S) URL.');
  }
  if (nodeEnv === 'production' && !publicWebUrl.startsWith('https://')) {
    throw new Error('PUBLIC_WEB_URL must use HTTPS in production.');
  }
  if (nodeEnv === 'production' && orderTrackingSecret.length < 32) {
    throw new Error('ORDER_TRACKING_SECRET must contain at least 32 characters in production.');
  }
  if (emailProvider !== 'resend') {
    throw new Error('EMAIL_PROVIDER currently supports only resend.');
  }
  if ((emailApiKey && !emailFrom) || (!emailApiKey && emailFrom)) {
    throw new Error('EMAIL_API_KEY and EMAIL_FROM must be configured together.');
  }
  if (!['true', 'false'].includes(paymentExpiryJobEnabledValue)) {
    throw new Error('PAYMENT_EXPIRY_JOB_ENABLED must be true or false.');
  }
  if (!Number.isInteger(paymentExpiryJobIntervalMs) || paymentExpiryJobIntervalMs < 10_000) {
    throw new Error('PAYMENT_EXPIRY_JOB_INTERVAL_MS must be an integer of at least 10000.');
  }
  if (!Number.isInteger(paymentExpiryBatchSize) || paymentExpiryBatchSize < 1) {
    throw new Error('PAYMENT_EXPIRY_BATCH_SIZE must be a positive integer.');
  }
  if (!['true', 'false'].includes(receiptPdfEnabledValue)) {
    throw new Error('RECEIPT_PDF_ENABLED must be true or false.');
  }
  if (!['local', 's3'].includes(receiptStorageProvider)) {
    throw new Error('RECEIPT_STORAGE_PROVIDER must be local or s3.');
  }
  if (receiptPdfEnabledValue === 'true' && receiptStorageProvider === 's3') {
    for (const key of [
      'RECEIPT_STORAGE_BUCKET',
      'RECEIPT_STORAGE_ACCESS_KEY_ID',
      'RECEIPT_STORAGE_SECRET_ACCESS_KEY',
    ]) {
      if (!String(config[key] ?? '').trim()) throw new Error(`${key} is required for S3 storage.`);
    }
  }
  if (!['local', 's3'].includes(assetStorageProvider)) {
    throw new Error('ASSET_STORAGE_PROVIDER must be local or s3.');
  }
  if (assetStorageProvider === 's3') {
    for (const key of [
      'ASSET_STORAGE_ENDPOINT',
      'ASSET_STORAGE_BUCKET',
      'ASSET_STORAGE_ACCESS_KEY_ID',
      'ASSET_STORAGE_SECRET_ACCESS_KEY',
    ]) {
      if (!String(config[key] ?? '').trim()) throw new Error(`${key} is required for S3 storage.`);
    }
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
    PAYOS_MASTER_KEY: payosMasterKey,
    PAYOS_WEBHOOK_BASE_URL: payosWebhookBaseUrl,
    PUBLIC_WEB_URL: publicWebUrl,
    ORDER_TRACKING_SECRET: orderTrackingSecret || 'local-order-tracking-secret-change-me',
    EMAIL_PROVIDER: emailProvider,
    EMAIL_API_KEY: emailApiKey,
    EMAIL_FROM: emailFrom,
    PAYMENT_EXPIRY_JOB_ENABLED: paymentExpiryJobEnabledValue === 'true',
    PAYMENT_EXPIRY_JOB_INTERVAL_MS: paymentExpiryJobIntervalMs,
    PAYMENT_EXPIRY_BATCH_SIZE: paymentExpiryBatchSize,
    RECEIPT_PDF_ENABLED: receiptPdfEnabledValue === 'true',
    RECEIPT_STORAGE_PROVIDER: receiptStorageProvider,
    RECEIPT_STORAGE_LOCAL_DIR: String(config.RECEIPT_STORAGE_LOCAL_DIR ?? 'uploads/receipts'),
    RECEIPT_STORAGE_ENDPOINT: String(config.RECEIPT_STORAGE_ENDPOINT ?? '').trim(),
    RECEIPT_STORAGE_REGION: String(config.RECEIPT_STORAGE_REGION ?? 'auto').trim(),
    RECEIPT_STORAGE_BUCKET: String(config.RECEIPT_STORAGE_BUCKET ?? '').trim(),
    RECEIPT_STORAGE_ACCESS_KEY_ID: String(config.RECEIPT_STORAGE_ACCESS_KEY_ID ?? '').trim(),
    RECEIPT_STORAGE_SECRET_ACCESS_KEY: String(
      config.RECEIPT_STORAGE_SECRET_ACCESS_KEY ?? '',
    ).trim(),
    ASSET_STORAGE_PROVIDER: assetStorageProvider,
    ASSET_STORAGE_ENDPOINT: String(config.ASSET_STORAGE_ENDPOINT ?? '').trim(),
    ASSET_STORAGE_REGION: String(config.ASSET_STORAGE_REGION ?? 'auto').trim(),
    ASSET_STORAGE_BUCKET: String(config.ASSET_STORAGE_BUCKET ?? '').trim(),
    ASSET_STORAGE_ACCESS_KEY_ID: String(config.ASSET_STORAGE_ACCESS_KEY_ID ?? '').trim(),
    ASSET_STORAGE_SECRET_ACCESS_KEY: String(config.ASSET_STORAGE_SECRET_ACCESS_KEY ?? '').trim(),
  };
}
