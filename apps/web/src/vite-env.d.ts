/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TRANSCRIPTION_WS_URL?: string;
  readonly VITE_TRANSCRIPTION_TOKEN_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
