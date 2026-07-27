export {};

declare global {
  interface Window {
    transcriber: import('../electron/preload').TranscriberApi;
  }
}
