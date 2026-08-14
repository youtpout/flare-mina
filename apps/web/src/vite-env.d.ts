/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Attestor API base URL. Defaults to localhost in development. */
  readonly VITE_API_URL?: string;
  /** 'mesa' switches the Mina side to the Mesa testnet. Default devnet. */
  readonly VITE_MINA_NETWORK?: string;
  /** Escrow zkApp on that network — required for mesa, which redeploys. */
  readonly VITE_MINA_BRIDGE_ACCOUNT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
