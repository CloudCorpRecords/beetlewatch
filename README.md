# beetlewatch

Follow the spread of the red-necked longhorn beetle (Aromia bungii) across Japan without keeping a local copy of the data in sync. beetlewatch is a small forwarding client for the hosted Kubiaka MCP service, which publishes beetle damage and support-programme data by municipality: the tool list is answered from your own machine using captured definitions, and each call travels upstream, with the service's answer handed back exactly as it arrived. The upstream tool descriptions are in Japanese and are served verbatim, exactly as captured.

Three of the service's five captured tools are exposed — the free published-data core. Ask for one municipality's damage status together with any newly found damage there and the rewards and subsidies it can use, list the municipalities newly found damaged since the national list (with dates and sources), or list the published reward and subsidy programmes — payments for catching adult beetles and support for tree owners' control and felling work, with application status and verification dates.

Two captured tools are deliberately not included: `get_changes_since` and `get_municipality_dossier`. Each is priced per call via x402, and beetlewatch never originates payment, so they are omitted individually beside the free core. No x402 or payment header is ever constructed or sent.

## The tools

- **`get_municipality_status`** — The damage status for one named `municipality` (Japanese or romaji; the city/town/village suffix is optional), plus newly found damage there and the rewards and subsidies available. An optional `prefecture` narrows the match when municipality names repeat.
- **`list_new_detections`** — Municipalities newly found damaged after the national list, with dates, details and sources. An optional `prefecture` filters the listing.
- **`list_rewards_and_subsidies`** — Reward and bounty programmes for people who catch adult beetles, and control/felling subsidies for tree owners, with application status and the dates each entry was verified. An optional `prefecture` filters, and `only_open` (default true upstream) keeps only programmes still accepting applications.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/beetlewatch mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "beetlewatch": {
      "command": "npx",
      "args": ["-y", "@reneturcios/beetlewatch", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/beetlewatch
docker run --rm ghcr.io/cloudcorprecords/beetlewatch list_new_detections '{}'
```

## CLI

A single binary covers both the command line and the MCP server. Every kept tool is a subcommand whose one argument is a JSON string of that tool's inputs:

```bash
beetlewatch get_municipality_status '{"municipality":"Kuwana"}'
beetlewatch get_municipality_status '{"municipality":"さいたま市","prefecture":"埼玉県"}'
beetlewatch list_new_detections '{}'
beetlewatch list_new_detections '{"prefecture":"三重県"}'
beetlewatch list_rewards_and_subsidies '{"only_open":true}'
beetlewatch --version
```

Exit codes: `0` for a successful forwarded call, `1` when the result that comes back is an error, and `2` for usage mistakes like an unknown subcommand or a JSON argument that does not parse. The two omitted tools have no subcommand: naming one is a usage error like any other unknown command.

## Configuration

- `KUBIAKA_MCP_URL` — Replaces the upstream endpoint. Defaults to the pinned hosted endpoint, `https://kubiaka-now.com/mcp`. (This override variable is a reconstruction introduced by this rebuild.)

The Kubiaka registry record lists no headers for its remote, so beetlewatch never attaches an authentication header — every call goes upstream keyless.

When the upstream cannot answer — it returns a JSON-RPC error, answers with a non-2xx status, sends a body that cannot be read, or the request itself fails — the caller receives an error result whose text begins with `beetlewatch error:`.

## How forwarding works

The first call of a process opens a session against the upstream: an `initialize` request (protocol version `2025-03-26`), a `notifications/initialized` notification, and then the `tools/call`. If the service issues an `Mcp-Session-Id` header during initialize, beetlewatch repeats it on subsequent requests and keeps reusing that one session until the process ends. Replies are understood in both plain JSON and server-sent-events framing. Successful results are passed through untouched, `isError` flag and any extra fields included.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The suite compares the served tool list against the captured surface tool for tool, proves the two omitted x402 tools are absent at the registry, MCP and CLI levels, walks the session handshake and its reuse, proves no `Authorization` header and no x402/payment header is sent under any environment, and confirms that arguments travel upstream unchanged and results return unchanged for every one of the three kept tools.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
