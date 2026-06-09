/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_BASE_URL: string
    readonly VITE_DEX_API_BASE_URL?: string
    readonly [key: string]: string | undefined
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}
