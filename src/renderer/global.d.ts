import type { PiLotApi } from "../shared/readiness";

declare global {
  interface Window {
    pilot: PiLotApi;
  }
}

export {};
