/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    dwh?: {
      invoke: <T = unknown>(
        cmd: string,
        args?: Record<string, unknown>,
      ) => Promise<T>;
      open: (opts?: {
        multiple?: boolean;
        directory?: boolean;
        filters?: { name: string; extensions: string[] }[];
      }) => Promise<string | string[] | null>;
      save: (opts?: {
        defaultPath?: string;
        filters?: { name: string; extensions: string[] }[];
      }) => Promise<string | null>;
      revealItemInDir: (path: string) => Promise<void>;
      windowAction?: (
        action:
          | "zoom-in"
          | "zoom-out"
          | "zoom-reset"
          | "toggle-fullscreen"
          | "close",
      ) => Promise<{ zoomFactor: number; fullScreen: boolean } | null>;
    };
  }
}
