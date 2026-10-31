import fs from 'node:fs';

// Load .env without an extra dependency
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || undefined,
  adminPassword: env.ADMIN_PASSWORD || '',
  appSecret: env.APP_SECRET || '',
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  millionVerifierKey: env.MILLIONVERIFIER_API_KEY || '',
  apiKey: env.OUTREACH_API_KEY || '',
  ntfyTopic: env.NTFY_TOPIC || '',
  dryRun: env.DRY_RUN === 'true',
  production: env.NODE_ENV === 'production' || !!env.RAILWAY_ENVIRONMENT,
};

export function assertConfig() {
  const problems: string[] = [];
  if (!config.adminPassword || config.adminPassword === 'change-me') problems.push('ADMIN_PASSWORD is not set');
  if (config.appSecret.length < 24) problems.push('APP_SECRET must be at least 24 characters');
  if (config.apiKey && config.apiKey.length < 32) problems.push('OUTREACH_API_KEY must be at least 32 characters');
  if (config.production && problems.length) {
    throw new Error(`Refusing to start: ${problems.join('; ')}`);
  }
  return problems;
}
