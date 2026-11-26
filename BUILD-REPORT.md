# BUILD REPORT — beetlewatch

Clean-room rebuild of `com.kubiaka-now/mcp` v1.0.0
(remote-only MCP server at `https://kubiaka-now.com/mcp`),
built 2026-10-28 as a forwarding client. Package: `@reneturcios/beetlewatch`
0.1.0, registry name `io.github.CloudCorpRecords/beetlewatch`.

## Surface built

**LABELLED SUBSET: 3 of 5 captured tools built.**

| Tool | Required fields as served |
|------|---------------------------|
| `get_municipality_status` | `municipality` |
| `list_new_detections` | *(none — no `required` key in the capture, served verbatim)* |
| `list_rewards_and_subsidies` | *(none — no `required` key in the capture, served verbatim)* |

**OMITTED (absent from the fixture and from the rebuild):**
`get_changes_since` and `get_municipality_dossier` — each is priced
per call via x402 in its own captured description ($0.01 and $0.005
respectively, test phase, Base Sepolia USDC). The rebuild never
originates payment, so the x402 tools are omitted individually beside
the free core (the draftpage pattern, Batch B7). Tests assert the
omissions are absent at registry level (TOOL_DEFS / TOOL_NAMES /
isKnownTool), MCP-layer level (tools/list carries neither; handleCallTool
and live MCP tools/call reject each with MethodNotFound and no network
hop), and CLI level (each name prints usage and exits 2). Tests also
assert no x402/payment header is ever constructed or sent (header-name
scan across a full session for every kept tool, including with
payment-style env vars present) and that no `Authorization` header is
sent under any environment.

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, exactly as captured. No inputSchema
carries a `$schema` marker or an `additionalProperties` key — none was
captured, none was invented. Property shapes are served verbatim:
`get_municipality_status` takes `municipality` + optional `prefecture`;
`list_new_detections` takes an optional `prefecture`;
`list_rewards_and_subsidies` takes an optional `prefecture` and an
optional `only_open` boolean. The tool descriptions and titles are
Japanese text, served verbatim, never translated or rewritten.
The tool literals were generated programmatically from
`harness/fixtures/kubiaka-tools-original.json` by the script
at `/tmp/laneb8-beetlewatch-scratch/gen.py` (parse + re-serialise,
spliced into `src/forward.ts` between the TOOL_DEFS_GENERATED
markers) — never retyped — and the generator's round-trip check
confirmed the spliced block parses back deep-equal to the
fixture's 3 tool objects, in order. Tools are registered via
the MCP SDK low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

The kept surface is three free reads of the published dataset on
red-necked longhorn beetle (クビアカツヤカミキリ) infestation in
Japan — per-municipality damage status and subsidy availability,
municipalities newly found damaged after the national list (with
dates and sources), and the published reward/subsidy programmes
(for catching adult beetles and for tree owners' control/felling
support, with application status and verification dates). Published
public data about places and public programmes: no caller-named
person/entity screening, no sends, no payments.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools' names,
titles, Japanese descriptions, the `required` arrays
(`municipality`; none for `list_new_detections` / none for
`list_rewards_and_subsidies`), the property shapes, and the
two omissions.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://kubiaka-now.com/mcp`.
- Env override `KUBIAKA_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent, under any environment. Tests assert that no
  `Authorization` header (and no `X-API-Key` header, and no
  x402/payment header of any name) is sent with an empty
  environment, with a `KUBIAKA_API_KEY`-style variable present,
  with `AUTHORIZATION` / `API_KEY` / `KUBIAKA_TOKEN` variables
  present, and with payment-style variables present.
- Error rendering `beetlewatch error:` text for upstream failures
  — labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; plain-JSON and SSE replies are both parsed. The
  forwarding core takes an injectable fetch; tests stub the
  upstream — no live network calls in tests, and no live call is
  claimed beyond the coordinator's tools/list capture.

## Deviations

**None.** No write-guard workaround was needed in this session:
the lockfile, `npm ci`, `tsc` build and test suite all ran
through the normal routes, and `dist/` is the direct output of
`tsc` on the validated sources.

## Lockfile

Generated clean from birth (Route 3, clean dir, no
`node_modules`, no pre-existing lockfile):
`npm install --package-lock-only --ignore-scripts --offline`
→ success. Parses as JSON; `name` == `@reneturcios/beetlewatch`;
exactly **128** package entries; sha256
`89128e9e145c66e9d596b59b2fd7c10444981476d4fa65fd17120288ab4c0c9e`.
`npm ci --ignore-scripts --offline` then succeeded and the
lockfile sha256 was re-verified **unchanged** afterwards.

## server.json

- Description exactly: "Red-necked longhorn beetle in Japan: municipal damage status, detections, subsidies." — **84 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/beetlewatch:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio. Dockerfile
  (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/beetlewatch"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/beetlewatch`
  and its smoke test asserts the server name `beetlewatch`.

## Verification (run 2026-10-28, builder session)

1. `npm install --package-lock-only --ignore-scripts --offline`
   → success; lockfile parses, name `@reneturcios/beetlewatch`,
   128 package entries (see Lockfile).
2. `npm ci --ignore-scripts --offline` → success; lockfile
   sha256 unchanged.
3. `tsc --noEmit` (direct `node_modules/.bin/tsc`) → exit 0.
4. `tsc` build → exit 0; `node dist/cli.js --version` → `0.1.0`.
5. Full suite (`tsx --test test/*.test.ts`, direct `node_modules/.bin/tsx`) → **70 tests,
   70 pass, 0 fail** (registration-integrity suite deep-equals
   the served tools/list against the fixture's 3 tools, in
   order, at both the registry level and through an
   in-memory-transport MCP `tools/list`; omission assertions at
   registry, MCP-layer and CLI level; per-tool schema detail
   assertions including the verbatim Japanese titles/descriptions;
   session handling/reuse, env override, the
   no-Authorization-header and no-x402/payment-header assertions
   under every environment, verbatim argument forwarding for all
   3 kept tools and result pass-through including upstream
   isError, SSE parsing, error rendering, MCP-layer validation,
   and CLI behaviour).
6. Parity (harness, tools-file mode):
   `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/kubiaka-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/beetlewatch/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/beetlewatch/parity-out`
   → **verdict PASS, parity 100.0** (3/3 identical, 0 missing,
   0 extra, no schema diffs). Output in `parity-out/`.
