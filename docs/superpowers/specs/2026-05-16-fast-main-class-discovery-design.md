# Fast Main Class Discovery — Design Spec

**Date:** 2026-05-16  
**Status:** Approved

## Problem

The current `findMainClasses` implementation reads every `.java` file individually via `fs.readFileString` and only scans `src/main/java` directories. This is slow on large projects and fails to find main classes in other source roots (`src/test/java`, etc.) or across modules in a monorepo.

## Goals

- Discover all `public static void main` classes across all Maven modules in a project tree
- Cover all source roots (not just `src/main/java`)
- Be fast enough for large monorepos
- Maven only; Gradle is out of scope

## Approach: `rg` + heuristic source root stripping

Replace the file-walk + per-file read with a single `rg` subprocess invocation.

### Command

```
rg --files-with-matches --glob "*.java" --glob "!target" \
   "public\s+static\s+void\s+main\s*\(\s*String" \
   <project-root>
```

- `--files-with-matches` — emit one file path per match, no line content needed
- `--glob "*.java"` — restrict to Java source files
- `--glob "!target"` — exclude build output directories
- Pattern matches the standard main method signature

### FQCN extraction

For each path returned by `rg`, extract the FQCN by:

1. Matching the path against `/src\/[^/]+\/java\//` (e.g. `src/main/java/`, `src/test/java/`, `src/intTest/java/`)
2. Taking everything after the last such match
3. Stripping the `.java` extension and replacing `/` with `.`

Paths that don't contain this segment (e.g. generated sources outside the standard layout) are silently skipped.

### Result

- Sorted alphabetically
- Deduplicated

## Error Handling

| Condition | Behaviour |
|---|---|
| `rg` exits 1 (no matches) | Return `[]` — not an error |
| `rg` not in PATH | Fail with `"ripgrep (rg) is required but not found in PATH"` |
| Path has no `src/*/java/` segment | Skip silently |

## Code Changes

**`src/services/JavaProject.ts`**

- Delete `findSrcMainJavaDirs` and `walkJavaFiles` helpers
- Delete `MAIN_METHOD_RE` in-process regex (reused as `rg` pattern string)
- Rewrite `findMainClasses` to run `rg` via `CommandExecutor`, parse stdout, extract FQCNs
- Remove `FileSystem` dependency from the layer (no longer needed)
- `Path` dependency retained for path manipulation
- All other exports (`resolveClasspath`, service tag, layer) unchanged

## Out of Scope

- Gradle support
- Non-standard `<sourceDirectory>` declared in pom.xml
- Classpath resolution improvements for multi-module projects
