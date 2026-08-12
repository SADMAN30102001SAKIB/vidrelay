export interface SecretBindings {
  AUDIT_HASH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  INSTAGRAM_APP_ID?: string;
  INSTAGRAM_APP_SECRET?: string;
  MEDIA_LEASE_SECRET?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_WEBHOOK_VERIFY_TOKEN?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
}

interface RuntimeVariableBindings {
  APP_ENV: "development" | "production";
  APP_ORIGINS: string;
  ALLOW_SIGNUPS: string;
  FACEBOOK_CAPABILITY: string;
  INSTAGRAM_CAPABILITY: string;
  META_GRAPH_VERSION: string;
  PUBLIC_API_ORIGIN: string;
  PUBLIC_APP_ORIGIN: string;
  R2_BUCKET_NAME: string;
  TIKTOK_CAPABILITY: string;
  UPLOAD_MODE: "direct" | "worker_proxy";
  YOUTUBE_CAPABILITY: string;
}

export type Bindings = Omit<CloudflareBindings, keyof RuntimeVariableBindings> &
  RuntimeVariableBindings &
  SecretBindings;

export interface AuthContext {
  role: "customer" | "operator";
  sessionHash: string;
  userId: string;
  workspaceId: string;
}

export interface Variables {
  auth: AuthContext;
  requestId: string;
}

export interface PublishWorkflowParams {
  attemptNumber: number;
  destinationId: string;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}

export const requireSecret = (value: string | undefined, name: string): string => {
  if (value === undefined || value.length === 0) {
    throw new Error(name + " is not configured.");
  }

  return value;
};
