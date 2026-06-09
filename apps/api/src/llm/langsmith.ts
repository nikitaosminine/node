// Shared LangSmith client factory. Tracing is opt-in: returns null when
// LANGSMITH_API_KEY is unset, so callers degrade to the un-traced path.
//
// CF Workers notes:
//  - Instantiate per request from the Worker env binding (no module-load env).
//  - Org-scoped API keys REQUIRE workspaceId (sent as x-tenant-id) or LangSmith
//    returns 403 Forbidden.
//  - EU-region accounts must set LANGSMITH_ENDPOINT to
//    https://eu.api.smith.langchain.com (default is US).
//  - Always call `client.flush()` before the request context tears down, or the
//    batched run events never send and runs are left "incomplete".

import { Client } from "langsmith";

export interface LangSmithEnv {
  LANGSMITH_API_KEY?: string;
  LANGSMITH_PROJECT?: string;
  LANGSMITH_ENDPOINT?: string;
  LANGSMITH_WORKSPACE_ID?: string;
}

export function langsmithClient(env: LangSmithEnv): Client | null {
  if (!env.LANGSMITH_API_KEY) return null;
  return new Client({
    apiKey: env.LANGSMITH_API_KEY,
    apiUrl: env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com",
    workspaceId: env.LANGSMITH_WORKSPACE_ID,
  });
}
