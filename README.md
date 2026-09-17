# cte2-pob

A standalone desktop build planner for Craft to Exile 2 (CTE2) featuring a full stat calculation engine and real damage pipeline.

## Build Planner Highlights

- **Complete Character Planning**: Allocate talents, skills, gear, omens, and class points with detailed stat breakdowns and damage models.
- **In-Game Build Exporter Mod**: Includes a client-side Forge mod (`mod/`) that exports your active character, gear, and exact in-game stat sheet directly into the planner—no server permissions required.
- **Portable & Zero-Install Version**: Available as a standalone `portable.exe` that runs from anywhere (like a USB drive) and keeps all local snapshot data isolated right beside the executable.
- **Local Asset Extraction**: Reads data directly from your local CTE2 installation on first run to avoid distributing game files.

## Quick Commands

- `npm run dev` — Launch the desktop app in development mode.
- `npm run dist:app` — Build the portable `.exe` and setup installer under `packages/app/dist/`.
