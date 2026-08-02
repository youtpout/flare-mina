/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Attestor API base URL. Defaults to localhost in development. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
