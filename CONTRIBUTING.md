# Contributing

## Development Setup

```bash
pnpm install
pnpm build
pnpm dev -- --help   # run from source
```

## Commands

```bash
pnpm test        # vitest watch mode
pnpm test:run    # vitest single run
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check
pnpm lint:fix    # biome check --write
```

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new command
fix: resolve port binding issue
docs: update README
refactor: simplify process tracking
test: add coverage for kill command
chore: bump dependencies
```

Scopes are optional: `feat(list): improve class detection`

## Release Process

1. `pnpm changelog` — regenerate `CHANGELOG.md` (requires `git-cliff`, install via `mise install git-cliff` or see [git-cliff docs](https://git-cliff.org/docs/installation))
2. Commit: `git commit -m "chore: update changelog for vX.Y.Z"`
3. Bump version in `package.json`
4. `git tag vX.Y.Z && git push --follow-tags` — triggers the release workflow

## Issues

Bug reports and feature requests welcome at the [issue tracker](../../issues).
