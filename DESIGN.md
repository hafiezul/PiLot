---
name: PiLot
description: A quiet, precise, native macOS workbench for Pi sessions.
---

<!-- SEED: re-run $impeccable document once there's code to capture the actual tokens and components. -->

# Design System: PiLot

## 1. Overview

**Creative North Star: "The Mac Workbench"**

PiLot should feel installed, familiar, and ready for sustained expert work: quiet enough to disappear behind the task, precise enough to make concurrent activity trustworthy, and native enough that Mac users can predict its behavior. Finder, Xcode, and System Settings are references for hierarchy, source lists, inspectors, focus, and standard controls—not visual templates.

Use restrained color and motion. Information hierarchy, typography, selection, and native control behavior carry the interface; decoration does not.

**Key Characteristics:**
- Quiet, precise, native
- Dense without becoming cramped
- Familiar macOS hierarchy and behavior
- Visible attention states without theatrical urgency
- State change motion only

## 2. Colors

Use tinted neutral application surfaces with one system-blue accent family `[to be resolved during implementation]` for selection, focus, and primary actions.

### Primary
- **System Action Blue** (`[to be resolved during implementation]`): Reserved for selected, focused, and actionable states; never decorative.

### Neutral
- **Window Surface** (`[to be resolved during implementation]`): Main session content.
- **Source List Surface** (`[to be resolved during implementation]`): Sidebar and supporting chrome.
- **Primary Ink** (`[to be resolved during implementation]`): Main text and high-priority labels.
- **Secondary Ink** (`[to be resolved during implementation]`): Metadata that still meets WCAG 2.2 AA.
- **Separator** (`[to be resolved during implementation]`): Native-feeling structural division.

**The Ten Percent Rule.** Accent color occupies no more than 10% of a screen; its rarity preserves meaning.

**The Semantic State Rule.** Failure, warning, success, and attention colors supplement text and icon labels; color never carries status alone.

## 3. Typography

**Display Font:** Single humanist system sans `[font family to be chosen at implementation]`
**Body Font:** The same humanist system sans `[font family to be chosen at implementation]`
**Label/Mono Font:** System monospace for code, commands, and paths only `[font family to be chosen at implementation]`

**Character:** Familiar and compact. Typography supports hierarchy and scanning without adding a separate display voice.

### Hierarchy
- **Headline:** Semibold fixed-size system sans for project and session titles.
- **Title:** Medium fixed-size system sans for panes and activity groups.
- **Body:** Regular fixed-size system sans for conversation, capped at 65–75ch for prose.
- **Label:** Medium compact system sans for controls, state, and metadata; sentence case by default.

**The One-Family Rule.** Use one humanist sans throughout the product; monospace appears only where content is genuinely code-like.

## 4. Elevation

Flat by default. Tonal surface changes and separators define persistent structure; restrained native shadows appear only for transient menus, popovers, sheets, and the prototype switcher. Motion communicates state changes only and must become instant or a simple crossfade under Reduce Motion.

**The Structural Depth Rule.** Persistent panes use tone and separators, never decorative card shadows.

## 6. Do's and Don'ts

### Do:
- **Do** use source lists, split views, menus, focus behavior, and controls that behave like native macOS applications.
- **Do** keep concurrent session states legible through text, icon, and restrained semantic color.
- **Do** keep routine activity compact while preserving inspectable detail.
- **Do** use system blue only for selection, focus, and primary action.

### Don't:
- **Don't** imitate Codex desktop, Claude Code, or T3 Code visually.
- **Don't** use chat-only navigation, embedded-IDE surface sprawl, terminal-painted interfaces, default-full-access affordances, or web chrome pretending to be macOS.
- **Don't** use decorative motion, glassmorphism, gradient text, oversized rounded cards, or color as the only state signal.
- **Don't** turn every activity or message into a card.
