/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
declare global {
  interface Window {
    __layoutListenersInit?: boolean;
    __gallerySwapInit?: boolean;
    __c?: boolean;
    help?: () => void;
    glitch?: (loop?: number) => string | void;
    invert?: () => string;
    pride?: () => string;
    prideful?: () => string;
    hi?: () => string;
  }
}

export {};
