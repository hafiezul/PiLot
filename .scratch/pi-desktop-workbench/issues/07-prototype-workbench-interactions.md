# Prototype native workbench interactions

Type: prototype
Status: resolved
Blocked by: 02, 03, 06

## Question

What native macOS information architecture and interaction model best supports the selected MVP workflows across projects, concurrent sessions, conversation, files/diffs, tool activity, approvals, and artifacts?

Use `/prototype` and `/impeccable`; create and link a rough interactive artifact for live product-owner feedback rather than deciding from prose alone.

## Answer

Use **A — Navigator + inspector** as PiLot's MVP interaction model: a native project/session source list, one focused session narrative, a stable composer, and a user-toggleable trailing changes inspector. Within each project, waiting and failed sessions rise above running and completed sessions, with recency ordering inside each state group.

Approvals and questions are pinned directly above the composer while active and remain represented at their originating point in the timeline. The trailing inspector is resizable and attached to the session window; narrow windows hide it by default rather than replacing the timeline or opening a separate utility window.

The supervision board is rejected as the default because it makes overview management compete with direct work. Session tabs are rejected as the primary navigation because they flatten the project/session hierarchy. Attention-first ordering in the source list preserves supervision without adding a second home surface.

The tested artifact is [PiLot workbench interaction prototype](../prototype/workbench-interactions/index.html). Run it with `python3 -m http.server 4173 -d .scratch/pi-desktop-workbench/prototype/workbench-interactions` and compare `?variant=A`, `?variant=B`, and `?variant=C`; variant A reflects the chosen pinned-interruption and toggleable-inspector behavior.
