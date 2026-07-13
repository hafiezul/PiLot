# Share the canonical Pi environment

PiLot will use the user's existing Pi environment by default rather than creating or importing an app-owned copy. This preserves CLI authentication, models, settings, compatible resources, and session continuity while allowing PiLot to pin a compatible Pi SDK version; PiLot will not execute extensions initially, and environment isolation can be added later only if real conflicts require it.
