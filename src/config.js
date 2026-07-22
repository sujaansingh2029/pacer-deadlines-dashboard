import dotenv from "dotenv";

dotenv.config();

export const config = {
  appBaseUrl: process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  openaiApiKey: process.env.OPENAI_API_KEY,
  pacerUsername: process.env.PACER_USERNAME,
  pacerPassword: process.env.PACER_PASSWORD,
  pacerClientCode: process.env.PACER_CLIENT_CODE,
  pacerLoginUrl: process.env.PACER_LOGIN_URL || "https://pacer.login.uscourts.gov/csologin/login.jsf",
  pacerUsernameField: process.env.PACER_USERNAME_FIELD,
  pacerPasswordField: process.env.PACER_PASSWORD_FIELD,
  pacerClientCodeField: process.env.PACER_CLIENT_CODE_FIELD,
  pacerOtpField: process.env.PACER_OTP_FIELD,
  pacerAuthCookie: process.env.PACER_AUTH_COOKIE,
  pacerAutoAcceptFees: String(process.env.PACER_AUTO_ACCEPT_FEES || "").toLowerCase() === "true",
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
