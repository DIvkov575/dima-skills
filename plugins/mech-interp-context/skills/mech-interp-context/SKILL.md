---
name: mech-interp-context
description: Load and verify the full 650k-token ARENA mechanistic-interpretability context from the local mech-interp project. Use before answering substantial questions about mechanistic interpretability, ARENA exercises, TransformerLens, NNsight, activation analysis, circuits, probing, attribution, or mech-interp research, and whenever the user asks to load the 650k context file.
---

# Mech Interp Context

Ground mechanistic-interpretability work in the exact local ARENA reference
artifact before analyzing the user's task.

## Load Workflow

1. Resolve the directory containing this `SKILL.md` as `<skill-dir>`.
2. Run:

   ```bash
   python3 <skill-dir>/scripts/load_context.py --check
   ```

3. Load the entire file before doing the requested analysis:

   ```bash
   python3 <skill-dir>/scripts/load_context.py
   ```

   Prefer a native file-read tool when it can ingest the full file. Get the
   verified path with:

   ```bash
   python3 <skill-dir>/scripts/load_context.py --path
   ```

4. If tool output limits truncate a full read, load every line in contiguous,
   non-overlapping ranges until line 48,640:

   ```bash
   python3 <skill-dir>/scripts/load_context.py --start-line 1 --end-line 4000
   ```

   Continue from line 4,001 with the next range. Do not skip ranges or claim the
   context was loaded before reaching line 48,640.

5. Complete the user's task using the loaded context. Distinguish facts found in
   the context from external knowledge or new inference.

## Context Contract

- Expected file: `resources/arena_all_650k.txt`
- Expected bytes: `2,327,866`
- Expected lines: `48,640`
- Expected SHA-256:
  `9b22955cd5e52cdce4b02c628c3da037df4540226aaa3107edb0def025dfb8ef`

The loader resolves the file in this order:

1. `--file <path>`
2. `$MECH_INTERP_CONTEXT_FILE`
3. `$MECH_INTERP_ROOT/resources/arena_all_650k.txt`
4. `~/workplace/mech-interp/resources/arena_all_650k.txt`

If resolution or validation fails, report the exact failure and stop. Never load
a similarly named file as a silent fallback.
