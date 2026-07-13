import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { appearances, type Appearance, type Preferences } from "../shared/preferences.js";

const defaults: Preferences = { appearance: "system", expandThinking: false };

export async function loadPreferences(directory: string): Promise<Preferences> {
  try {
    const saved = JSON.parse(await readFile(path.join(directory, "preferences.json"), "utf8")) as Partial<Preferences>;
    return {
      appearance: appearances.includes(saved.appearance as Appearance) ? saved.appearance as Appearance : defaults.appearance,
      expandThinking: saved.expandThinking === true,
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

export async function saveAppearance(directory: string, appearance: string): Promise<Preferences> {
  if (!appearances.includes(appearance as Appearance)) throw new Error("Unknown appearance preference");
  return savePreferences(directory, { ...await loadPreferences(directory), appearance: appearance as Appearance });
}

export async function saveExpandThinking(directory: string, expandThinking: unknown): Promise<Preferences> {
  if (typeof expandThinking !== "boolean") throw new Error("Unknown thinking visibility preference");
  return savePreferences(directory, { ...await loadPreferences(directory), expandThinking });
}
