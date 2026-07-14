import dotenv from "dotenv";

dotenv.config();

export const config = {
  appBaseUrl: process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  openaiApiKey: process.env.OPENAI_API_KEY,
  cronSecret: process.env.CRON_SECRET || "dev-secret",
  sessionSecret: process.env.SESSION_SECRET || "dev-session-secret",
  dashboardPassword: process.env.DASHBOARD_PASSWORD
};

export function assertRequiredConfig() {
  const missing = [];
  for (const [key, value] of Object.entries({
    DATABASE_URL: config.databaseUrl,
    GOOGLE_CLIENT_ID: config.googleClientId,
    GOOGLE_CLIENT_SECRET: config.googleClientSecret
  })) {
    if (!value) missing.push(key);
  }
  return missing;
}
