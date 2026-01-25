# BL Language Support

Language support for Z8 BL files in VS Code.

## Features
- Go to definition for classes, methods, members, and imports.
- References for methods and identifiers.
- Diagnostics for unknown methods/members and basic syntax issues.
- Navigation to compiled Java and native Java (when available).
- Syntax highlighting for BL specifics.

## Debugging
- `BL: Analyze Current Line` — inspect parsed chains and type resolution.
- `BL: Dump Diagnostics` — list diagnostics with source and code.

See `AGENTS.md` for detailed debugging and agent guidance.

## Contributing
See `CONTRIBUTING.md` for workflow and guidelines.

## CI publishing
Pushes to `master` publish to the Marketplace via GitHub Actions.
Set repository secret `VSCE_PAT` with Marketplace publish scope.

## Release process
- Patch (bug fixes): `npm version patch --no-git-tag-version`
- Minor (new features): `npm version minor --no-git-tag-version`
- Major (breaking changes): `npm version major --no-git-tag-version`
- Commit `package.json` and push to `master` to publish.

## Commands
- `BL: Перейти к скомпилированному Java`
- `BL: Перейти к native Java`
- `BL: Show Context Debug`
- `BL: Analyze Current Line`
- `BL: Dump Diagnostics`

## Requirements
No external dependencies.

## License
MIT
