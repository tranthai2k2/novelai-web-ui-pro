# LoRA Processor Integration

This document explains how the current web app integrates the external Python processor at `D:\no\lora_processor.py`.

## Goal

The current app does not inherit the Tkinter LoRA browser UI from `D:\no\lora_browser.py`.
It only reuses the processing workflow for the active character:

1. Read `Character Tags (Dynamic)` from the selected character card.
2. Read that card's folder path.
3. Call the external Python processor.
4. Create a temporary prompt TXT inside this repo.
5. Read the generated prompt lines.
6. Generate images line by line using:
   `processed line + base prompt + current settings`

## Current Behavior

When the user presses `Generate`:

1. The app resolves the active character from the Multiple/Character panel.
2. If that character has both:
   - a non-empty `Character Tags (Dynamic)`
   - a non-empty folder path
   then the frontend calls `POST /api/process-character-prompts`.
3. The backend runs a local bridge script:
   [tools/lora_processor_bridge.py](/f:/novelai-web-ui-pro/tools/lora_processor_bridge.py)
4. The bridge imports the external processor module from the path configured in Settings.
5. The bridge runs:
   - `run_tag_enhancer(folder)`
   - `process_character_txt(folder, character_prompt)`
6. The generated character TXT is copied into:
   `f:\novelai-web-ui-pro\temp_character_prompts\`
7. The backend returns all non-empty lines from that TXT to the frontend.
8. The frontend stores those lines in `promptsFromFile`.
9. Generation continues using one line at a time, combined with the current Base Prompt and settings.

## Temp TXT Lifecycle

Temporary prompt TXT files are stored in:

- `f:\novelai-web-ui-pro\temp_character_prompts\`

These files are deleted automatically whenever the Node server starts.
The cleanup happens in:

- [server.ts](/f:/novelai-web-ui-pro/server.ts)

This means the temp TXT folder is intentionally ephemeral and should not be treated as permanent storage.

## Files Involved

### Frontend

- [src/App.tsx](/f:/novelai-web-ui-pro/src/App.tsx)

Responsibilities:

- Stores the external processor path in Settings.
- Sends `Character Tags (Dynamic)` and folder path to the backend.
- Saves returned prompt lines to the current character card.
- Uses those lines during generation and auto-browsing.

Important frontend function:

- `syncCharacterPrompts(character)`

This function is the frontend entry point for processor-backed prompt generation.

### Backend

- [server.ts](/f:/novelai-web-ui-pro/server.ts)

Responsibilities:

- Clears temp TXT files on startup.
- Exposes `POST /api/process-character-prompts`.
- Launches the bridge script with Python.
- Returns generated prompt lines and temp TXT path to the frontend.

Important backend helpers:

- `ensureCleanTempCharacterPromptsDir()`
- `processCharacterPromptToTempFile(...)`

### Python Bridge

- [tools/lora_processor_bridge.py](/f:/novelai-web-ui-pro/tools/lora_processor_bridge.py)

Responsibilities:

- Dynamically imports the external processor module by file path.
- Calls the processor functions.
- Copies the generated character TXT into the repo temp folder.
- Prints a JSON payload for the Node backend to consume.

### External Source of Truth

The actual processing logic still lives outside this repo:

- [D:\no\lora_processor.py](/D:/no/lora_processor.py)

That file remains the source of truth for:

- `run_tag_enhancer`
- `process_character_txt`
- breast-size replacement logic
- tag tier behavior

## Data Flow

### Input

The integration only uses:

- `Character Tags (Dynamic)`
- the selected character's folder path

It does not use the Tkinter LoRA browser selection UI.

### Output

The processor returns line-based prompts.
Each line becomes one dynamic prompt candidate for generation.

The final generation prompt is built like this:

- `processed_line + Character Tags (Dynamic) + Base Prompt`

In the current code path, the line from `promptsFromFile` is combined with the character prompt and then with the global Base Prompt in:

- [src/App.tsx](/f:/novelai-web-ui-pro/src/App.tsx)

## Settings

The external processor path is currently configurable in the Settings tab.
Default value:

- `D:\no\lora_processor.py`

If the external file moves in the future, update the field in the UI before generating.

## Update Guide

If future maintenance is needed, use this order:

1. Check whether `D:\no\lora_processor.py` changed.
2. If its function signatures changed, update:
   - [tools/lora_processor_bridge.py](/f:/novelai-web-ui-pro/tools/lora_processor_bridge.py)
   - [server.ts](/f:/novelai-web-ui-pro/server.ts)
3. If generation flow or prompt composition needs to change, update:
   - [src/App.tsx](/f:/novelai-web-ui-pro/src/App.tsx)
4. If temp file behavior changes, update:
   - [server.ts](/f:/novelai-web-ui-pro/server.ts)
   - this document

## Known Constraints

- The integration depends on a working local Python environment.
- The integration depends on the external file path staying valid.
- The temp prompt files are wiped on each server start.
- The web app currently reuses the processor logic, not the original Tkinter browser UI.

## Recommended Future Improvements

- Persist the external processor path in local storage or a config file.
- Add a dedicated processor status area in the UI.
- Surface the processor's success/error message directly next to the active character card.
- Optionally vendor a stable copy of the processor logic into this repo if external path dependency becomes fragile.
