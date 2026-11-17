# github-forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ItsSuperMeow/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ItsSuperMeow/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge, built for the [make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01). One process, no UI, its own store, no outside service, no git binary — Node standard library only.

## What it implements

- **Git smart HTTP** (`/<owner>/<repo>.git`): protocol v2 `upload-pack` (`ls-refs`, `fetch`, shallow clones, deepen), v0 `upload-pack` and `receive-pack` (fast-forward only, per-ref `report-status`, `side-band-64k`, `delete-refs`). Packfiles are read and written from scratch on `node:zlib` + `node:crypto` (OFS/REF deltas resolved, thin packs accepted).
- **REST v3** (`/api/v3`): repositories, branches, commits, contents (base64, stale-sha 409), labels, issues + comments, pull requests with squash merge, pagination via `Link`, `X-GitHub-Request-Id` on every reply, Bearer-token auth (401 without it, 404 never 403 across owners).
- **GraphQL v4** (`/api/graphql`): the documents `gh` and `github-mcp-server` send — `repository`, `issues` (states + `orderBy` + cursor pagination), `pullRequests`, `node(id:)`, `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment`, plus `__type` introspection for `Issue`, `PullRequest`, `Repository` and `SearchType`.
- **MCP** (`/mcp`): JSON-RPC 2.0 over Streamable HTTP, revision `2026-07-28` (`server/discover`) with the legacy `initialize` handshake as a fallback. Six tools — `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` — acting on the same store as REST.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry ↔ env lifecycle (bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`, exit 0). `app.ts` is the server; the forge lives in `git.ts` (objects + packfiles), `gitproto.ts` (smart HTTP), `store.ts` (repos/issues/PRs + git state), `rest.ts`, `graphql.ts` and `mcp.ts`.

Requires Node 22.18+.

## Local grading

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process --instances 3
```

Practice trials score **~980/1000** (feature 600/600, agent 200/200, perf ~180/200).

## License

MIT — see [LICENSE](LICENSE).
