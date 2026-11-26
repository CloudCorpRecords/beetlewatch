# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Kubiaka MCP server, which publishes data on the red-necked longhorn beetle in Japan. Three of the five captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `get_municipality_status`, `list_new_detections`, `list_rewards_and_subsidies` — per-municipality damage status and subsidy availability, municipalities newly found damaged after the national list, and the published reward/subsidy programmes for catching adult beetles and for tree owners' control/felling support.
- Labelled subset: `get_changes_since` and `get_municipality_dossier` are omitted — each is priced per call via x402, and this rebuild never originates payment. No x402/payment header is ever constructed or sent.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `beetlewatch error:` text results.
- One bin serves the CLI (one subcommand per kept tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `KUBIAKA_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent.
