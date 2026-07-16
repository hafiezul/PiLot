import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { app } from "electron";

export const TEST_OAUTH_PROVIDER_ID = "pilot-test-oauth";

type OAuthProvider = ReturnType<AuthStorage["getOAuthProviders"]>[number];
type TestProviderScenario = "browser" | "device" | "failure-once" | "manual" | "prompt" | "select";
let loginAttempts = 0;

function cancelled() {
  return new Error("Authentication cancelled.");
}

function delay(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 750);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(cancelled());
    }, { once: true });
  });
}

export function providerAuthTestFixture(): OAuthProvider | undefined {
  if (app.isPackaged || !process.argv.includes("--pilot-test-provider-auth")) return undefined;
  const scenario = process.env.PILOT_TEST_PROVIDER_AUTH as TestProviderScenario | undefined;
  if (!scenario || !(["browser", "device", "failure-once", "manual", "prompt", "select"] as const).includes(scenario)) return undefined;
  const credentials = () => ({
    access: "fixture-access-value",
    refresh: "fixture-refresh-value",
    expires: Date.now() + 60_000,
  });
  return {
    id: TEST_OAUTH_PROVIDER_ID,
    name: "PiLot OAuth Fixture",
    usesCallbackServer: scenario === "browser" || scenario === "manual",
    async login(callbacks) {
      switch (scenario) {
        case "browser":
          callbacks.onAuth({ url: "https://example.invalid/fixture-callback", instructions: "Complete the deterministic browser callback." });
          await delay(callbacks.signal);
          break;
        case "device":
          callbacks.onDeviceCode({ userCode: "PILOT-TEST", verificationUri: "https://example.invalid/fixture-device" });
          await delay(callbacks.signal);
          break;
        case "failure-once": {
          loginAttempts += 1;
          if (loginAttempts === 1) {
            callbacks.onProgress?.("Checking fixture provider");
            throw new Error("Fixture provider rejected authentication.");
          }
          const value = await callbacks.onPrompt({ message: "Enter the fixture authorization code", placeholder: "fixture-code" });
          if (!value) throw new Error("A fixture authorization code is required.");
          break;
        }
        case "manual": {
          callbacks.onAuth({ url: "https://example.invalid/fixture-manual", instructions: "Complete login in the browser or enter the manual code." });
          const value = await callbacks.onManualCodeInput?.();
          if (!value) throw new Error("A fixture manual code is required.");
          break;
        }
        case "prompt": {
          const value = await callbacks.onPrompt({ message: "Enter the fixture authorization code", placeholder: "fixture-code" });
          if (!value) throw new Error("A fixture authorization code is required.");
          break;
        }
        case "select": {
          const value = await callbacks.onSelect({
            message: "Choose a fixture account",
            options: [{ id: "personal", label: "Personal account" }, { id: "team", label: "Team account" }],
          });
          if (!value) throw cancelled();
          break;
        }
      }
      return credentials();
    },
    async refreshToken() {
      return credentials();
    },
    getApiKey(credential) {
      return credential.access;
    },
  };
}
