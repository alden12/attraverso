# Running attraverso in Claude Desktop

Claude Desktop is the MCP client: it launches the server as a subprocess and talks JSON-RPC over its stdin and
stdout. Point it at the server with an `mcpServers` entry in
`~/Library/Application Support/Claude/claude_desktop_config.json`.

## Setting it up

Install the package once, then point Desktop at it by absolute path:

```sh
npm install -g attraverso
command -v node                          # the node to name in the config
echo "$(npm root -g)/attraverso/server.js"   # the server to run
```

```json
{
  "mcpServers": {
    "attraverso": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/node_modules/attraverso/server.js"]
    }
  }
}
```

Keep any keys already in the file. Then **fully quit and reopen Claude Desktop**: it keeps the server process
alive across a conversation, so it must relaunch to pick up a config change or a new version.

**Why absolute paths, rather than `npx` as in Claude Code.** Desktop is launched by launchd, which does not
inherit your shell's `PATH`. A bare `node` or `npx` (especially one installed through nvm) is not found, and
`npx` is itself a script that looks `node` up on the `PATH`. Naming both files directly avoids the lookup.
Upgrading is `npm install -g attraverso` again; the paths stay the same.

If the tools do not appear, the Desktop log usually says why:
`~/Library/Logs/Claude/mcp-server-attraverso.log`. To prove the command in isolation, run exactly what the
config runs and check that it prints nothing to stdout:

```sh
/absolute/path/to/node /absolute/path/to/node_modules/attraverso/server.js </dev/null
# expect only stderr ("attraverso MCP server ready on stdio"); any stdout line would corrupt the stream
```

## Trying it

In a conversation, ask for something like "create a software project called `demo`", "add an item in area MCP:
wire up the server", "list the items", "set MCP-1 to in-progress", or "show me the graph". The tools describe
themselves, and `get_project` returns the project's protocol - its operating manual - first.

## Where your data lives

There is **no database file**. PGlite is in-memory and is rebuilt on every boot; the durable copy is a YAML
file, written atomically after each change.

Under Claude Desktop that file is:

```
~/.ai-project-manager/project.apm.yaml
```

It is created empty the first time the server starts, so the path exists before you have written anything.

**Why not the nearest `*.apm.yaml`, as in Claude Code.** The server normally finds its store by walking up
from the working directory. launchd starts Desktop at `/`, so there is nothing to find and the home-dir
fallback applies.

**One file holds many projects.** The store is a list of projects, so `create_project` adds to it: a software
project, a language and a houseplant schedule can share `project.apm.yaml`, and questions across projects work
because they are all in the one rebuilt database. A second file is for when you want a different home for it,
such as a plan committed to its own repo.

To point Desktop at a specific store instead, add either of these to the `mcpServers` entry:

```json
"args": ["/absolute/path/to/node_modules/attraverso/server.js", "--store", "/absolute/path/to/plan.apm.yaml"]
```

```json
"env": { "APM_STORE_PATH": "/absolute/path/to/plan.apm.yaml" }
```

Be deliberate about that: pointing Desktop at a store committed to a repo means any personal project you create
in conversation also lands in that repo's file, and in its diffs.

## Seeing the graph

Ask for it ("show me the roadmap", "open the viewer") and the `open_viewer` tool starts the graph viewer and
hands back a URL. It renders **the store this server has loaded**, wherever its YAML lives.

The URL ends in the project's key (`.../#demo`), so it opens on the project you were talking about. The
toolbar switches between projects and the URL follows, so a link is worth bookmarking.

- **Loopback only** (`127.0.0.1`, the first free port from 5177). The plan is a whole project's thinking, so it
  is never bound to the network. That also means it opens only on the machine running the server.
- **The port is taken lazily**, on the first `open_viewer` call, so a server you only talk to through tools
  never holds a port. Asking twice returns the same URL.

## Running from source instead

For working on attraverso itself, `yarn setup:desktop` in a checkout writes a config that runs the server from
source and checks that stdout stays clean. It points at that checkout, so it is for development, not for using
the published package.
