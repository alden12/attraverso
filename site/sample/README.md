# A sample plan, for trying the site's folder page and the workbook

A small plan (the e2e fixture's demo, with a Next list) in the layout a real project has, to open, edit and break
without touching a real one. Nothing here is real data.

- `attraverso.yaml` and `.attraverso/references.yaml`: the plan and its source references.
- `plan.xlsx` and `plan.snapshot.json`: the plan as a workbook (`DIST-9.2`), and what it was exported from.

**See it in the browser** (`DIST-9.1`): run `yarn workspace attraverso site`, open `/open/` in Chrome or Edge, and
choose this folder. The page follows the files, so an edit to `attraverso.yaml` shows up within a couple of seconds.

**Round-trip the workbook**: edit `plan.xlsx` (or have an agent edit it), then, from `packages/core`:

```
yarn workbook refresh --project demo --store site/sample/attraverso.yaml --dir site/sample          # report only
yarn workbook refresh --project demo --store site/sample/attraverso.yaml --dir site/sample --apply  # apply, re-export
```

`--apply` writes the plan and re-exports the workbook, so `git checkout site/sample` puts everything back.
