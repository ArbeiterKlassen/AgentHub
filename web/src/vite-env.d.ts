/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AH_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
