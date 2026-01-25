# Contributing

Thanks for helping improve Z8 BL Language Support.

## Where to contribute
- **master** is the release branch.
- **dev** is the development branch.

Please create your branch from `dev` and open PRs **into `dev`**. Avoid direct pushes to `master`.

## Development setup
1) Clone the repo
2) Open in VS Code
3) Run the extension in a dev host:
   - Press `F5` (Run and Debug)
   - Or run `code --extensionDevelopmentPath=.`

## Testing changes
- Verify diagnostics and navigation in sample `.bl` files.
- Use `BL: Analyze Current Line` and `BL: Dump Diagnostics` for debugging.
- See `AGENTS.md` for detailed diagnostics and tracing.

## Style and conventions
- Keep changes small and focused.
- Prefer readable code over clever code.
- Keep files ASCII when possible.
- Update or add comments only when logic is non-obvious.

## Pull requests
Include in your PR description:
- What was changed and why.
- How it was tested (steps + sample files).
- Any known limitations.

## Reporting issues
Please include:
- File path and line number
- Output from `BL: Dump Diagnostics`
- Output from `BL: Analyze Current Line`
- Where Ctrl/Cmd+Click navigates (if wrong)
