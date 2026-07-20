---
name: PiLot
description: A quiet native desktop command center for concurrent Pi tasks.
colors:
  ink: "#20211f"
  ink-secondary: "#555651"
  ink-muted: "#686864"
  chalk-canvas: "#f4f4f3"
  paper: "#f7f7f6"
  fog-chrome: "#ebebea"
  cloud-control: "#fdfdfc"
  input-white: "#ffffff"
  surface-subtle: "#efefed"
  surface-selected: "#dededb"
  hairline: "#d7d7d4"
  hairline-subtle: "#e3e3df"
  signal-blue: "#1668d4"
  signal-blue-hover: "#0e57b7"
  harbor-blue-text: "#315d91"
  harbor-blue-surface: "#edf1f5"
  amber-caution-text: "#805814"
  amber-caution-surface: "#f7f3e9"
  rust-alert-text: "#a12c2c"
  rust-alert-surface: "#fff7f7"
  moss-confirm: "#287c47"
  diff-add: "#1f6b3b"
  diff-delete: "#963434"
  text-on-accent: "#ffffff"
typography:
  page-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  section-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: "normal"
    letterSpacing: "-0.015em"
  subsection-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: "normal"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 650
    letterSpacing: "0.06em"
  mono:
    fontFamily: "ui-monospace, 'SFMono-Regular', Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "5px"
  lg: "6px"
  xl: "7px"
  "2xl": "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  "2xl": "32px"
  "3xl": "42px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.text-on-accent}"
    rounded: "50%"
    padding: "0"
    size: "32px"
  button-primary-hover:
    backgroundColor: "{colors.signal-blue-hover}"
  button-secondary:
    backgroundColor: "{colors.cloud-control}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-subtle}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "7px 8px"
  nav-item-selected:
    backgroundColor: "{colors.surface-selected}"
  input-field:
    backgroundColor: "{colors.input-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
  status-badge:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.sm}"
    padding: "3px 7px"
---

# Design System: PiLot

## Overview

**Creative North Star: "The Quiet Dispatch Desk"**

PiLot presents several active jobs without making the interface feel busy. The composition is compact, orderly, and calm: routine activity recedes, while exceptions, decisions, handoffs, and evidence become immediately legible. Codex desktop informs project and task orchestration, Linear informs hierarchy and state clarity, and GitHub Desktop informs focused change review and external-tool integration. The shipped implementation carries this through faithfully: a three-pane shell built from `light-dark()` tokens, a single accent reserved for meaning, and a run timeline instead of chat bubbles.

The interface is focused, capable, and transparent. It feels at home on macOS and Windows rather than imposing a browser-product skin. It explicitly rejects terminal emulators, generic chatbot shells, and the persistent file trees, editor tabs, minimaps, and panel density of a VS Code clone.

**Key Characteristics:**

- Near-monochrome surfaces (ink, chalk canvas, fog, cloud) with one accent — Signal Blue (`#1668d4`) — reserved for focus, links, and primary action
- An adaptive three-pane shell (navigation / task / inspector) that collapses the inspector before task navigation on narrower widths
- A run-centric timeline (`.run-evidence`, `.assistant-text`, `.tool-evidence`) instead of conversation bubbles
- Compact but breathable information density: a 10–22px fixed type scale, not fluid clamp()
- Native OS chrome: a draggable 38px window bar, platform-conventional dialogs, focus rings, and menu placement
- Readable task state (running / queued / failed / interrupted) via bordered text badges, never color alone
- Motion that explains state changes (150–200ms) and then gets out of the way
- Official provider brand marks (via `simple-icons`) for built-in providers; one generic three-node glyph for custom providers

## Colors

Every color in the system is declared once via `light-dark()`, so light and dark appearance share a single semantic token and never drift independently. The palette is near-monochrome in both appearances; only signal colors and diff/state colors carry any saturation.

### Primary
- **Signal Blue** (`{colors.signal-blue}` `#1668d4`, dark: `#72aef4`): the one accent. Used for focus rings, links, the composer send button, active-run indication, and primary dialog actions — nowhere else.

### Neutral
- **Ink** (`{colors.ink}` `#20211f`, dark: `#e8e8e5`): primary text.
- **Ink Secondary** (`{colors.ink-secondary}` `#555651`): secondary text, section labels, project icons.
- **Ink Muted** (`{colors.ink-muted}` `#686864`): metadata, timestamps, helper copy.
- **Chalk Canvas** (`{colors.chalk-canvas}` `#f4f4f3`, dark: `#1d1e1c`): the outer shell background behind panes.
- **Paper** (`{colors.paper}` `#f7f7f6`, dark: `#1d1e1c`): the main content surface.
- **Fog** (`{colors.fog-chrome}` `#ebebea`, dark: `#242523`): the second neutral layer — navigation, inspector, tab bar, window bar.
- **Cloud** (`{colors.cloud-control}` `#fdfdfc`, dark: `#30312e`): buttons, popovers, dialogs, the readiness panel.
- **Hairline** (`{colors.hairline}` `#d7d7d4`, dark: `#50514d`): default dividers and control borders.

### Semantic (state)
- **Harbor Blue** (`{colors.harbor-blue-text}` `#315d91` on `{colors.harbor-blue-surface}` `#edf1f5`): running / live / informational state.
- **Amber Caution** (`{colors.amber-caution-text}` `#805814` on `{colors.amber-caution-surface}` `#f7f3e9`): queued, interrupted, continuity warnings.
- **Rust Alert** (`{colors.rust-alert-text}` `#a12c2c` on `{colors.rust-alert-surface}` `#fff7f7`): failed, aborted, destructive actions.
- **Moss Confirm** (`{colors.moss-confirm}` `#287c47`): success indicators (the privacy dot, connected providers).
- **Diff Green / Diff Red** (`{colors.diff-add}` `#1f6b3b` / `{colors.diff-delete}` `#963434`): addition/deletion counts and diff gutters only.

### Named Rules
**The Signal-Only Color Rule.** Color is reserved for selection, focus, links, warnings, errors, success, active run state, and official provider marks. Provider marks may use their own brand color for recognition (rendered via `simple-icons`, adapted per appearance); every other surface stays neutral.

**The True Neutral Rule.** Base backgrounds (`chalk-canvas`, `paper`, `fog`, `cloud`) carry no hue lean — not cream, not blue-gray, not green-tinted. Brand character comes from composition, typography, and the rare accent, not a tinted canvas.

**The Light-Dark Parity Rule.** Every color is authored once through `light-dark(light, dark)`. There is no second, independently-maintained dark theme — a new token is wrong until both values are supplied.

## Typography

**Display Font:** none — PiLot has no display face.
**Body Font:** `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` (the host platform sans).
**Label/Mono Font:** `ui-monospace, "SFMono-Regular", Consolas, monospace`.

**Character:** one system sans carries every UI role from page title to metadata; only code, diffs, paths, commands, model IDs, and token/byte figures switch to monospace. The pairing is intentionally unremarkable — the interface should read as native chrome, not as a designed artifact.

### Hierarchy
- **Page Title** (`{typography.page-title}`, 700, 22px/1.25, −0.02em): command-center and settings page `h1`.
- **Section Title** (`{typography.section-title}`, 700, 20px, −0.015em): `h2` — project/task page headings.
- **Subsection Title** (`{typography.subsection-title}`, 700, 14px): `h3` — run headings, dialog headings, settings group headings.
- **Body** (`{typography.body}`, 400, 13px/1.5): task copy, form labels, run evidence text. Prose blocks cap at 62–72ch (`.thinking-evidence p`, `.settings-introduction`).
- **Label** (`{typography.label}`, 650, 11–12px, +0.06em tracked, uppercase): nav section headers (`Projects`), fieldset legends. Reserved for structural chrome labels, never body copy.
- **Meta** (10–11px, `ink-muted`): timestamps, run numbers, byte/token counts — always `font-variant-numeric: tabular-nums` where they align in a column.
- **Mono** (`{typography.mono}`, 11px): file paths, commands, diffs, model identifiers.

### Named Rules
**The Native Type Rule.** UI labels, buttons, menus, and task metadata use the host system sans. Monospace never spreads into general navigation or prose simply to signal that PiLot is a developer tool.

**The Fixed Scale Rule.** Every size in the hierarchy is a literal `px` value (22/20/16/15/14/13/12/11/10), never a fluid `clamp()`. PiLot is viewed at consistent desktop DPI inside a resizable window, not a responsive marketing viewport.

## Elevation

PiLot is flat by default. Depth comes from tonal surface changes (canvas → chrome → control), 1px dividers, and selection backgrounds — not shadows. Shadows exist only on the six transient overlay tokens below, each scoped to a layer that is temporarily floating above the shell.

### Shadow Vocabulary
- **Tooltip** (`box-shadow: 0 2px 6px rgb(20 20 19 / 15%)`): pane-divider hints.
- **Popover** (`box-shadow: 0 4px 8px rgb(20 20 19 / 16%)`): menus, model picker, composer completions.
- **Command** (`box-shadow: 0 12px 28px rgb(20 20 19 / 24%)`): the command palette, the single deepest surface in the app.
- **Toast** (`box-shadow: 0 4px 10px rgb(20 20 19 / 18%)`): the bottom-right action-error toast.
- **Inspector** (`box-shadow: -8px 0 18px rgb(20 20 19 / 20%)`): the inspector when it floats over content at narrow widths.
- **Drawer** (`box-shadow: 4px 0 8px rgb(20 20 19 / 18%)`): the mobile navigation drawer.

### Named Rules
**The Structural Elevation Rule.** A shadow must explain which surface temporarily sits above another. Static cards and routine panels (the readiness panel, the task composer, settings groups) do not earn decorative drop shadows — they're bordered, not lifted.

## Components

Every interactive component ships default, hover, focus-visible, and disabled states at minimum; run-affecting controls also carry a busy/wait state (`cursor: wait`, reduced opacity).

### Buttons
- **Shape:** `{rounded.md}` (5px) on rectangular buttons; `50%` on the composer send/stop actions and the settings gear.
- **Primary** (`button-primary`): Signal Blue fill, white text, used once per surface — the composer send action and a dialog's primary action (`.primary-action`). Padding `6px 10px`, or `0` on the 32px circular send button.
- **Secondary** (`button-secondary`): `{colors.cloud-control}` fill, 1px `{colors.hairline}`-family border (`--control-border`), used for every routine action (New Task, timeline refresh, dialog footers).
- **Ghost** (`button-ghost`): transparent, `{colors.ink-secondary}` text, used for icon-only chrome (nav-heading add button, settings gear, attachment trigger) — background appears only on hover/selection.
- **Hover / Focus:** secondary and ghost buttons hover to `{colors.surface-subtle}`-family backgrounds; the primary button darkens via `filter: brightness(.9)`. All interactive elements get a 2px `{colors.signal-blue}` `focus-visible` outline, 2px offset.
- **Disabled:** `opacity: .52–.55`, `cursor: not-allowed`; run-affecting buttons mid-flight use `cursor: wait` instead.

### Chips / Badges
- **Status badge** (`status-badge`, e.g. `.run-status`, `.task-state`): bordered pill/rect, no fill — border and text color carry the state (neutral hairline border by default; Harbor Blue for running, Amber for queued, Rust for failed/interrupted). Never a filled colored badge.
- **Count pill** (`.tab-badge`, `.history-label`): `{rounded.pill}` (999px), `{colors.surface-subtle}`-family background, tabular-nums.

### Cards / Containers
PiLot avoids decorative cards. The two container patterns are:
- **Composer** (`.task-composer`): `{rounded.xl}` (7px), 1px `--control-border`, `{colors.cloud-control}` background — a functional input container, not a card.
- **Dialogs** (`<dialog>` native element: task creation, project access, worktree removal): `{rounded.2xl}` (8px), `{colors.surface-dialog}` background, backdrop via `--backdrop-dialog`. No border-radius above 8px anywhere in the system.

### Inputs / Fields
- **Style** (`input-field`): 1px `--control-border`/`--change-button-border`, `{rounded.sm}` (4px), `{colors.input-white}` background, `padding: 6px 8px`, `min-height: 34px`.
- **Focus:** 2px Signal Blue outline; the composer textarea's parent (`.task-composer:has(textarea:focus-visible)`) gets the same outline plus a matching border so the whole container reads as focused.
- **Toggle rows** (radio/checkbox settings rows): full-width `label`, `min-height: 58px`, 1px top border, `accent-color: {colors.signal-blue}` on the native control, `<strong>`/`<small>` two-line copy.

### Navigation
- **Style:** the sidebar (`fog-chrome` background) lists projects and, for the selected project, its active tasks indented under a `task-nav-list`. Rows are `nav-item` — transparent by default, `{colors.surface-selected}`-family background with `font-weight: 650` when `aria-current="page"`.
- **Tabs** (inspector Changes/History): underline style — 2px bottom border in `ink`-family only on the selected tab, 48px height, no background change.
- **Mobile:** below 679px, the sidebar becomes a fixed drawer (`.navigation.mobile-visible`) with a scrim and a 44px top toolbar; all touch targets grow to the 44×44px minimum.

### Signature Components
- **The π Mark** (`.mark`): the brand glyph — a literal "π" character, Georgia serif 17px, centered in a 25×25px box with a 6px-radius single-pixel border. It is the only serif and the only non-system-font element in the interface, used exactly once (the sidebar brand button).
- **Provider Icons** (`ProviderIcon`): official brand SVGs from `simple-icons`, recolored per-provider via `--provider-color`/`--provider-color-dark` and adapted for legibility in dark mode; custom providers fall back to one generic three-node glyph. This is the system's sanctioned exception to the Signal-Only Color Rule.

## Do's and Don'ts

### Do:
- **Do** author every color as `light-dark(light, dark)` on a single semantic token — never a second dark-mode override block.
- **Do** keep multiple task states scannable without forcing every detail onto the screen.
- **Do** keep navigation, the focused task, and a collapsible contextual inspector spatially stable.
- **Do** organize transcript content into runs (`.run-evidence`) with compact evidence rows and expandable `<details>`.
- **Do** use platform-standard menu placement, keyboard behavior, native `<dialog>`/`popover` elements, focus treatment, and window lifecycle.
- **Do** make running, queued, interrupted, failed, and externally-changed states distinguishable by border + text color together, never color alone.
- **Do** use legible, theme-adaptive official brand marks for built-in providers and the one generic glyph for custom providers.
- **Do** delegate editing and full terminal work to the user's chosen tools.
- **Do** keep transitions between 150–200ms and remove nonessential motion under `prefers-reduced-motion`.
- **Do** cap border-radius at 8px anywhere in the system (dialogs); most controls sit at 4–7px.

### Don't:
- **Don't** build a terminal emulator and call it a desktop interface.
- **Don't** present PiLot as a generic chatbot with a conversation list and undifferentiated message bubbles.
- **Don't** make PiLot a VS Code clone; no persistent editor tabs, minimap, IDE file tree, or competing editor chrome.
- **Don't** copy Codex desktop visually; borrow its project/task workflow while keeping PiLot's own restrained language.
- **Don't** use color as decoration, gradient text, glassmorphism, oversized radii, nested cards, or wide soft shadows.
- **Don't** animate content merely because it entered the viewport or the application started.
- **Don't** fill a status badge with a saturated background — state badges are bordered text, not colored chips.
- **Don't** introduce a second font family. The π mark's Georgia serif is a one-time signature, not a pattern to extend.
