/**
 * Browser-safe entrypoint. Never imports @google-cloud/speech, Application
 * Default Credentials, or anything from server.ts.
 */
export { CloudEngineClient } from "./CloudEngineClient";
export type { CloudEngineClientOptions } from "./CloudEngineClient";
