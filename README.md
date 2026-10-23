# attraverso

Durable, structured project memory for AI coding agents, over [MCP](https://modelcontextprotocol.io).

An agent is good at working on a project and bad at remembering it three weeks later. The usual workaround is
a `CLAUDE.md` file that grows unmaintainably, cannot be queried, and rots. Attraverso moves that state into a
real store: the plan, the reasoning behind it, and the record of what was decided - retrieved as a
budget-bounded slice rather than dumped into context wholesale.

The plan lives as version-controlled YAML committed alongside your code, so it is reviewable in a pull request
like any other file, and is rebuilt into an in-memory Postgres ([PGlite](https://pglite.dev)) on load.

## Using it

Requires Node 22 or newer.

### In Claude Code

Add it to the `.mcp.json` at the root of your repo:

```json
{
  "mcpServers": {
    "attraverso": {
      "command": "npx",
      "args": ["-y", "attraverso", "--store", "plan.apm.yaml"]
    }
  }
}
```

The store file is created on first run. Commit it: it is the source of truth, and its diffs are the history of
the plan.

Then ask the agent to call `get_project`, or just to create a project and start planning. The tools describe
themselves, and `get_project` returns the project's protocol - its operating manual - first.

### Where the plan lives

In order of precedence:

1. `--store <path>` (repeatable: a plan can span several files), or `APM_STORE_PATH`.
2. The nearest `*.apm.yaml` found walking up from the working directory, like `tsconfig.json`.
3. `~/.ai-project-manager/project.apm.yaml`, for a personal project with no repo to live in.

### Seeing it

Ask the agent to open the viewer (the `open_viewer` tool). It serves the plan as a dependency graph on a
`127.0.0.1` address, so it only opens on the machine running the server.

### Claude Desktop

Claude Desktop starts servers without your shell's `PATH`, so a bare `npx` or `node` is often not found. See
[docs/claude-desktop.md](docs/claude-desktop.md) for the setup and the three ways it silently breaks.

## Developing

```sh
yarn install
yarn verify          # typecheck, viewer build, unit tests
yarn verify:all      # plus the end-to-end suite (once: npx playwright install chromium)
yarn viewer          # the graph on http://localhost:5176
```

`yarn test:pg` runs the same suite against a server Postgres (`yarn pg:up` starts one in Docker).

To try a change against a real plan, run the server from source over any store: `yarn mcp:dev --store
<path>`, or point a `.mcp.json` at `node_modules/.bin/vite-node src/mcp/server.ts`.

Releasing is `yarn build:standalone`, then `npm publish standalone/`: the published package is a single
self-contained build that needs nothing installed but Node.

## How this repo is maintained

Attraverso is developed in a private repository alongside a hosted version, and the open core is mirrored here
automatically. Issues and pull requests are welcome here; a merged pull request is carried across to the
private repository with its authorship kept, and comes back out in the next export.

## Licence

[Apache-2.0](LICENSE).
