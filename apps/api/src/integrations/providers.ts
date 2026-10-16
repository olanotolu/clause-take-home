import type { IntegrationProvider } from "../store/types.ts";

export interface ProviderInfo {
  id: IntegrationProvider;
  name: string;
  description: string;
  authUrl: string;
  tokenUrl: string;
  apiBase: string;
  scope: string;
  supportsRefresh: boolean;
}

const envName = (provider: IntegrationProvider, suffix: string) => `CLAUSE_${provider.toUpperCase()}_${suffix}`;

export const PROVIDERS: ProviderInfo[] = [
  { id: "imanage", name: "iManage", description: "Import documents from iManage Work.", authUrl: "", tokenUrl: "", apiBase: "", scope: "", supportsRefresh: true },
  { id: "netdocuments", name: "NetDocuments", description: "Import documents from NetDocuments.", authUrl: "", tokenUrl: "", apiBase: "", scope: "", supportsRefresh: true },
  { id: "onedrive", name: "OneDrive", description: "Import Word documents and PDFs from OneDrive.", authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token", apiBase: "https://graph.microsoft.com/v1.0", scope: "openid profile email offline_access User.Read Files.Read", supportsRefresh: true },
  { id: "dropbox", name: "Dropbox", description: "Import documents from Dropbox.", authUrl: "https://www.dropbox.com/oauth2/authorize", tokenUrl: "https://api.dropboxapi.com/oauth2/token", apiBase: "https://api.dropboxapi.com/2", scope: "account_info.read files.metadata.read files.content.read", supportsRefresh: true },
  { id: "google_drive", name: "Google Drive", description: "Import Google Docs, Word documents, PDFs, and text files.", authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", apiBase: "https://www.googleapis.com/drive/v3", scope: "openid email https://www.googleapis.com/auth/drive.readonly", supportsRefresh: true },
  { id: "sharepoint", name: "SharePoint", description: "Import documents from SharePoint libraries.", authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token", apiBase: "https://graph.microsoft.com/v1.0", scope: "openid profile email offline_access User.Read Sites.Read.All Files.Read.All", supportsRefresh: true },
  { id: "box", name: "Box", description: "Import documents from Box.", authUrl: "https://account.box.com/api/oauth2/authorize", tokenUrl: "https://api.box.com/oauth2/token", apiBase: "https://api.box.com/2.0", scope: "root_readonly", supportsRefresh: true },
];

export function providerConfig(provider: IntegrationProvider, env: Record<string, string | undefined> = process.env): ProviderInfo & { clientId: string; clientSecret: string; redirectUri: string; configured: boolean } {
  const base = PROVIDERS.find((p) => p.id === provider)!;
  const clientId = env[envName(provider, "CLIENT_ID")] ?? "";
  const clientSecret = env[envName(provider, "CLIENT_SECRET")] ?? "";
  const redirectUri = env[envName(provider, "REDIRECT_URI")] ?? `${env.PUBLIC_APP_URL ?? ""}/api/integrations/${provider}/callback`;
  const encryptionKey = env.CLAUSE_INTEGRATION_ENCRYPTION_KEY ?? "";
  const keyConfigured = /^[0-9a-f]{64}$/i.test(encryptionKey) || Buffer.from(encryptionKey, "base64").length === 32;
  const authUrl = env[envName(provider, "AUTH_URL")] ?? base.authUrl;
  const tokenUrl = env[envName(provider, "TOKEN_URL")] ?? base.tokenUrl;
  const apiBase = env[envName(provider, "API_BASE")] ?? base.apiBase;
  return {
    ...base,
    authUrl,
    tokenUrl,
    apiBase,
    scope: env[envName(provider, "SCOPE")] ?? base.scope,
    clientId,
    clientSecret,
    redirectUri,
    configured: Boolean(clientId && clientSecret && keyConfigured && authUrl && tokenUrl && apiBase && (redirectUri.startsWith("https://") || /^http:\/\/localhost(?::\d+)?\//.test(redirectUri))),
  };
}

export function providerById(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
