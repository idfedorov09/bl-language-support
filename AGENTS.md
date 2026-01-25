# BL Language Support: agent guide

This folder contains a VS Code extension for the BL language. Use this doc to debug and improve navigation/diagnostics with AI agents.

## Quick start
- Reload VS Code after any code changes (Command Palette: "Developer: Reload Window").
- Output panel: "BL Debug" is the main trace channel.
- Use `BL: Analyze Current Line` and `BL: Dump Diagnostics` to capture signal for debugging.

## Extension structure
- `extension.js`: language features (definitions, references, diagnostics, hover, code lens, debug commands).
- `blIndex.js`: file indexer / parser for .bl files.
- `syntaxes/bl.tmLanguage.json`: TextMate grammar for syntax highlighting.
- `language-configuration.json`: basic language config (brackets, comments, etc.).
- `package.json`: activation, commands, menus, grammar registration.

### Core concepts
- **Index** (`blIndex.js`):
  - Parses `.bl` files into classes with: `packageName`, `className`, `extendsName`, `imports`, `members`, `methods`, etc.
  - Resolves types by full name, same-package, and explicit imports.
  - Tracks enums, records blocks, and inline attributes in member declarations.

- **Diagnostics** (`extension.js`, `collectDiagnostics`):
  - Parses chains like `a.b().c` and validates members/methods.
  - Adds diagnostics with `source = BL` and `code` (e.g. `chain`, `call`, `brace`).
  - Handles inline class contexts and array/map element types.

- **Navigation** (Definition provider):
  - Supports go-to-definition for imports, classes, members, methods, inline locals.
  - Supports compiled Java (`.java` in module `.java/` folder) and native Java references.
  - Special handling for `new Class.method(...)` so the first segment is forced to class resolution.

## Debug commands (must use)

### 1) BL: Analyze Current Line
Purpose: inspect parsing of chains and type resolution.

Output fields:
- `LineText`: sanitized text of the active line.
- `Chains`: detected chains.
- `Segments`: per chain, including `[i]` when indexing.
- `ForceClass`: `true` when chain starts after `new`.
- `Candidates[n]`: resolved type candidates after each segment.

Use when:
- A chain is mis-resolved.
- `Ctrl+Click` goes to the wrong type.
- A method/member is reported missing but exists.

Expected usage:
1) Put cursor on the problematic line.
2) Run `BL: Analyze Current Line`.
3) Check `Candidates[0]` and `Segment[n] found=...` output.

### 2) BL: Dump Diagnostics
Purpose: list all diagnostics with source and code.

Output fields:
- `Total diagnostics` and `Line diagnostics` count.
- Each diagnostic line shows: `[source code] Lx:col-Ly:col message`.

Use when:
- Red underline appears but you are unsure which pass created it.
- You need to know if the extension is responsible (`source=BL`).

Expected usage:
1) Put cursor on the problematic line.
2) Run `BL: Dump Diagnostics`.
3) Look for `[BL chain]` vs `[BL call]` vs other codes.

## Typical debugging workflow
1) Reproduce issue in the editor.
2) Run `BL: Dump Diagnostics` to confirm `source=BL`.
3) Run `BL: Analyze Current Line` to see chain parsing and resolution.
4) If candidates are wrong:
   - check imports in the file,
   - verify index parsing in `blIndex.js` (member/method parse),
   - verify type resolution paths in `resolveClassName`.
5) If candidates are correct but error still appears:
   - check `collectDiagnostics` chain/call logic.

## Known diagnostic codes
- `chain`: emitted by chain traversal (e.g., `a.b().c`).
- `call`: emitted by simple call scanning (e.g., `foo()` not in class).
- `brace`: bracket mismatch errors.
- `return-modifier`: invalid modifier after `return`.

## Notes for AI agents
- Always keep line numbers stable: `sanitizeText()` preserves line breaks.
- Prefer `rg` for search, avoid mass edits.
- When fixing false positives, check if `new` context or index access (`[i]`) is involved.
- Use `resolveChainTypeCandidates(..., forceFirstClass)` when `new Class.method()` is expected.
- If a method exists but diagnostics say unknown, validate:
  - class parsing captured the method (check `blIndex.js` regex),
  - chain parsing includes correct segments,
  - correct type candidate after indexing.

## What to include in bug reports
- File path and line number.
- Output from `BL: Dump Diagnostics` (full output).
- Output from `BL: Analyze Current Line` (for the same line).
- Whether `Ctrl+Click` is wrong and where it jumps.

