import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { editorIds, type EditorId } from "../shared/editors.js";
import { appearances, type Appearance, type Preferences } from "../shared/preferences.js";

const defaults: Preferences = { appearance: "system", expandThinking: false };
let preferenceWrites = Promise.resolve();

export async function loadPreferences(directory: string): Promise<Preferences> {
  try {
    const saved = JSON.parse(await readFile(path.join(directory, "preferences.json"), "utf8")) as Partial<Preferences>;
    const preferredEditor = editorIds.has(saved.preferredEditor as EditorId) ? saved.preferredEditor as EditorId : undefined;
    return {
      appearance: appearances.includes(saved.appearance as Appearance) ? saved.appearance as Appearance : defaults.appearance,
      expandThinking: saved.expandThinking === true,
      ...(preferredEditor ? { preferredEditor } : {}),
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

export async function savePreferredEditor(directory: string, editor: unknown): Promise<Preferences> {
  if (typeof editor !== "string" || !editorIds.has(editor as EditorId)) throw new Error("Unknown editor preference");
  return updatePreferences(directory, (current) => ({ ...current, preferredEditor: editor as EditorId }));
}
