---
name: PiLot
description: A quiet native desktop command center for concurrent Pi tasks.
---

<!-- SEED: re-run $impeccable document once there's code to capture the actual tokens and components. -->

# Design System: PiLot

## Overview

**Creative North Star: "The Quiet Dispatch Desk"**

PiLot presents several active jobs without making the interface feel busy. The composition is compact, orderly, and calm: routine activity recedes, while exceptions, decisions, handoffs, and evidence become immediately legible. Codex desktop informs project and task orchestration, Linear informs hierarchy and state clarity, and GitHub Desktop informs focused change review and external-tool integration.

The interface is focused, capable, and transparent. It must feel at home on macOS and Windows rather than imposing a browser-product skin. It explicitly rejects terminal emulators, generic chatbot shells, and the persistent file trees, editor tabs, minimaps, and panel density of a VS Code clone.

**Key Characteristics:**

- Near-monochrome surfaces with color reserved for meaning
- An adaptive three-pane shell that collapses the contextual inspector before task navigation
- A run-centric timeline instead of conversation bubbles
- Compact but breathable information density
- Native OS chrome, platform-conventional controls, menus, typography, and window behavior
- Readable task state across concurrent work
- Motion that explains state changes and then gets out of the way

## Colors

The palette is near-monochrome in both light and dark appearance. Exact OKLCH values will be resolved during implementation and tested to WCAG 2.2 AA; body text should target 7:1 contrast where practical.

**The Signal-Only Color Rule.** Color is reserved for selection, focus, links, warnings, errors, success, and active run state. It never decorates inactive surfaces or fills large areas merely to create identity.

**The True Neutral Rule.** Base backgrounds remain genuinely neutral rather than cream, blue-gray, or green-tinted. Brand character comes from composition, typography, and the rare accent—not a tinted canvas.

## Typography

**Direction:** Platform system sans with system monospace for code, diffs, paths, commands, model identifiers, and token figures. Exact stacks and metrics will be resolved during implementation.

Typography follows native macOS and Windows conventions while preserving equivalent hierarchy and density. The scale is compact and fixed rather than fluid; labels and controls remain familiar, while transcripts retain comfortable reading measure.

**The Native Type Rule.** UI labels, buttons, menus, and task metadata use the host system sans. Monospace never spreads into general navigation or prose simply to signal that PiLot is a developer tool.

## Elevation

PiLot is flat by default. Depth comes from tonal surface changes, dividers, selection state, and window-native layering; shadows are reserved for transient overlays such as menus, popovers, and dialogs. Exact elevation tokens will be resolved from implemented components.

**The Structural Elevation Rule.** A shadow must explain which surface temporarily sits above another. Static cards and routine panels do not earn decorative drop shadows.

## Do's and Don'ts

### Do:

- **Do** keep multiple task states scannable without forcing every detail onto the screen.
- **Do** keep navigation, the focused task, and a collapsible contextual inspector spatially stable.
- **Do** organize transcript content into runs with compact evidence rows and expandable details.
- **Do** use platform-standard menu placement, keyboard behavior, dialogs, focus treatment, and window lifecycle.
- **Do** make running, queued, interrupted, failed, and externally changed states distinguishable without relying on color alone.
- **Do** delegate editing and full terminal work to the user's chosen tools.
- **Do** keep transitions between 150–200ms and remove nonessential motion under reduced-motion preferences.

### Don't:

- **Don't** build a terminal emulator and call it a desktop interface.
- **Don't** present PiLot as a generic chatbot with a conversation list and undifferentiated message bubbles.
- **Don't** make PiLot a VS Code clone; no persistent editor tabs, minimap, IDE file tree, or competing editor chrome.
- **Don't** copy Codex desktop visually; borrow its project/task workflow while maintaining PiLot's own restrained language.
- **Don't** use color as decoration, gradient text, glassmorphism, oversized radii, nested cards, or wide soft shadows.
- **Don't** animate content merely because it entered the viewport or the application started.
