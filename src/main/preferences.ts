import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { applicationIds, type ApplicationId } from "../shared/editors.js";
import { appearances, type Appearance, type Preferences } from "../shared/preferences.js";

const defaults: Preferences = { appearance: "system", expandThinking: false };
let preferenceWrites = Promise.resolve();

export async function loadPreferences(directory: string): Promise<Preferences> {
  try {
    const saved = JSON.parse(await readFile(path.join(directory, "preferences.json"), "utf8")) as Partial<Preferences> & { preferredEditor?: unknown };
    const preferredApplication = applicationIds.has(saved.preferredApplication as ApplicationId)
      ? saved.preferredApplication as ApplicationId
      : applicationIds.has(saved.preferredEditor as ApplicationId) ? saved.preferredEditor as ApplicationId : undefined;
    return {
      appearance: appearances.includes(saved.appearance as Appearance) ? saved.appearance as Appearance : defaults.appearance,
      expandThinking: saved.expandThinking === true,
      ...(preferredApplication ? { preferredApplication } : {}),
    };
  } catch {
    return defaults;
  }
}

async function savePreferences(directory: string, preferences: Preferences) {
  const target = path.join(directory, "preferences.json");
  const temporary = `${target}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, JSON.stringify(preferences, null, 2));
  await rename(temporary, target);
  return preferences;
}

function updatePreferences(directory: string, update: (current: Preferences) => Preferences) {
  const pending = preferenceWrites.then(async () => savePreferences(directory, update(await loadPreferences(directory))));
  preferenceWrites = pending.then(() => undefined, () => undefined);
  return pending;
}

export async function saveAppearance(directory: string, appearance: string): Promise<Preferences> {
  if (!appearances.includes(appearance as Appearance)) throw new Error("Unknown appearance preference");
  return updatePreferences(directory, (current) => ({ ...current, appearance: appearance as Appearance }));
}

export async function saveExpandThinking(directory: string, expandThinking: unknown): Promise<Preferences> {
  if (typeof expandThinking !== "boolean") throw new Error("Unknown thinking visibility preference");
  return updatePreferences(directory, (current) => ({ ...current, expandThinking }));
}

export async function savePreferredApplication(directory: string, application: unknown): Promise<Preferences> {
  if (typeof application !== "string" || !applicationIds.has(application as ApplicationId)) throw new Error("Unknown application preference");
  return updatePreferences(directory, (current) => ({ ...current, preferredApplication: application as ApplicationId }));
}
