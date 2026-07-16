import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPreferences, savePanePreferences } from "../dist/main/main/preferences.js";

test("defaults pane widths when loading preferences saved before resizing support", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilot-preferences-"));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "preferences.json"), JSON.stringify({
      panes: { inspectorVisible: true, inspectorView: "changes" },
    }));

    await expect(loadPreferences(directory)).resolves.toMatchObject({
      panes: {
        inspectorVisible: true,
        inspectorView: "changes",
        navigationWidth: 230,
        inspectorWidth: 360,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("defaults pane widths that fall outside supported bounds", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilot-preferences-"));
  try {
    await writeFile(path.join(directory, "preferences.json"), JSON.stringify({
      panes: {
        inspectorVisible: false,
        inspectorView: "history",
        navigationWidth: 179,
        inspectorWidth: 601,
      },
    }));

    await expect(loadPreferences(directory)).resolves.toMatchObject({
      panes: {
        inspectorVisible: false,
        inspectorView: "history",
        navigationWidth: 230,
        inspectorWidth: 360,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists preferred pane widths with the other pane preferences", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilot-preferences-"));
  try {
    await expect(savePanePreferences(directory, {
      inspectorVisible: true,
      inspectorView: "history",
      navigationWidth: 260,
      inspectorWidth: 420,
    })).resolves.toMatchObject({
      panes: {
        inspectorVisible: true,
        inspectorView: "history",
        navigationWidth: 260,
        inspectorWidth: 420,
      },
    });

    expect(JSON.parse(await readFile(path.join(directory, "preferences.json"), "utf8"))).toMatchObject({
      panes: {
        inspectorVisible: true,
        inspectorView: "history",
        navigationWidth: 260,
        inspectorWidth: 420,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
