#!/bin/sh
# The MCP entry point, so `.mcp.json` names a stable path that does not encode a
# subcommand. Everything else, including the first-run install, is bin/hexdocs.
set -eu
exec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/bin/hexdocs" mcp "$@"
