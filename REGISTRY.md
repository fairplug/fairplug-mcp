# Publishing to the official MCP Registry (not yet done)

Name: `io.github.fairplug/fairplug-mcp` (GitHub namespace auth: requires publishing as a member of the `fairplug` GitHub org/user).

1. Install the CLI: `brew install mcp-publisher` or download the release binary from https://github.com/modelcontextprotocol/registry/releases
2. Confirm `server.json` is valid against the current schema (`mcp-publisher validate` if available; check the `$schema` URL is current).
3. `mcp-publisher login github` (device flow: open the URL, enter the code, signed in as the GitHub account that owns the `fairplug` namespace; the org membership must be public for org namespaces).
4. `mcp-publisher publish`
5. Verify: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.fairplug/fairplug-mcp"`

Remote-only server: no package/npm entry is needed.
