# Automating AgentsInTheCloud

AgentsInTheCloud's web UI operations also provide compact JSON representations for agents and scripts. They are the same operations used by the Turbo UI, not a separate REST implementation.

## Discovery

The authoritative contract for the running instance is:

```http
GET /openapi.json
```

Discover available Agent types with `GET /agent-types`; the response contains `agentTypes` and `defaultAgentTypeId`. Agent summaries identify their implementation with `agentTypeId`.

Inspect it without loading the whole document into context:

```sh
curl -s http://localhost:3000/openapi.json | jq -r '.paths | keys[]'
curl -s http://localhost:3000/openapi.json | jq '.paths["/workspaces/{id}/commands/{commandId}"]'
```

Send these headers for JSON operations:

```http
Accept: application/json
Content-Type: application/json
Origin: http://localhost:3000
```

Mutations and WebSocket upgrades require `Origin` to match the destination's public origin (scheme, hostname, and port). Use `http://localhost:3000` when accessing localhost, or your actual Tailscale URL, such as `https://machine.tailnet.ts.net`. Origins are resolved per request; no allowlist is needed. Missing, foreign, and `null` origins return a plain-text `403` before dispatch. Other application errors use `{ "error": { "code": "...", "message": "..." } }`.

The check uses the request URL's hostname and port, not forwarded-host/public-origin metadata. Only loopback connections may supply `X-Forwarded-Proto` (`http` or `https`) for TLS termination. Nested ingress translates same-origin requests and preserves foreign-origin denials.

This is CSRF protection, not authentication. Keep management unreachable from untrusted containers and untrusted HTML on separate origins or opaque-origin sandboxes. Token-authenticated agent MCP and turn-boundary endpoints retain their separate policy.

## Present a workspace

Workspace, Agent, and Work-view destinations are browser-navigable surfaces:

```text
/workspaces/:workspaceId
/workspaces/:workspaceId?agent=:agentId
/workspaces/:workspaceId?workView=:key
```

The `agent` and `workView` parameters may be combined to choose both sides of the desktop workspace. Use `GET /workspaces/:workspaceId` with `Accept: application/json` to discover the available Agent IDs and the `key` of each Work view.

## Present workspace template settings

Workspace template settings has a browser-navigable surface that agents can pass directly to their presentation tool:

```text
/workspace-templates/:workspaceTemplateId/settings
/workspace-templates/:workspaceTemplateId/settings?section=environment
```

Supported sections are `index`, `general`, `secrets`, `ssh`, `environment`, `network`, `container`, and `machines`. The index lists the settings sections; each section opens a focused page in the complete AgentsInTheCloud shell. Use `editor=new` or a record ID for Secrets, SSH keys, Environment Variables, or machine profiles, `editor=docker`, `images`, or `dockerfile` for Container, and `editor=limit` for the machines-per-workspace limit. Legacy section links (`repository`, `ssh-keys`, `privileged`, `dockerfile`, `preload-images`, and `danger`) still resolve to their corresponding pages.

**Machines** lists the profiles Agents may create test machines from on the LXD servers connected in Settings, and how many machines one Workspace may hold. Create, update and delete profiles with `POST /workspace-templates/:workspaceTemplateId/machine-profiles[/:profileId[/delete]]`, and set the limit with `POST /workspace-templates/:workspaceTemplateId/max-machines`. Changes apply to machines created afterwards.

**Secrets** manages protected credential entries shared with a template's Workspaces. Agents receive placeholders; real values are substituted into requests to allowed hosts. Secret changes apply to existing Workspaces, while Environment Variables only apply to new containers. Secret summaries never return real values.

**Global workspace settings** hold Secrets, SSH keys, trusted SSH servers and Environment variables for every new workspace, including empty ones. They use the same endpoints under `/global-workspace-settings` instead of `/workspace-templates/:workspaceTemplateId`; `GET /global-workspace-settings` with `Accept: application/json` lists them. A template's own Secret or Environment variable with the same name overrides the global one. Present them with `/settings?section=global-workspace-settings`, or inside a template's settings with `section=global-secrets`, `global-ssh` or `global-environment`. Global summaries have no `workspaceTemplateId`.

Use `GET /workspace-templates` with `Accept: application/json` to discover the template ID before constructing the presentation URL. Template environment-variable, secret, and SSH-key summaries identify their template with `workspaceTemplateId`. Existing storage filenames and serialized formats are unchanged; their older `project` spellings remain at storage boundaries.

Other browser-navigable surfaces are:

```text
/workspaces/new                                           # Launch composer for an empty workspace
/workspace-templates/:workspaceTemplateId/workspaces/new  # Launch composer for a workspace from a template
/workspace-templates/new                                  # Add a template
/models                                 # Models: Model providers, their usage, and enabled models
/settings                               # Settings: app-level preferences and shared configuration
/settings?section=models                # A specific settings section
/settings/developer-tools               # Developer tools: app-level maintenance and design-system inspection
/host                                   # Host: System diagnostics
/design-system-catalogue.html           # Live component catalogue (HTML)
```

Host targets AgentsInTheCloud System, outside individual Workspaces, rather than necessarily the physical machine running Docker. `GET /host` with `Accept: application/json` reports availability and the access boundary.

**Developer tools** is the app-level maintenance and design-system inspection page, separate from Workspace template configuration. The existing `/settings/development` URL remains valid.

**Theme** is an app-wide setting shared across open pages, not a per-Workspace or per-browser preference. Its settings section is `theme`.

Settings shows the **AgentsInTheCloud URL** for the current browser connection, with copy and QR-code actions. It is not necessarily reachable from other devices; a local-only address must be opened on the Installation computer.

The `access` section controls **Connection mode** in a System-managed installation: **Installation computer only** or **Devices on your Tailscale network**. The existing access API spelling is unchanged.

**Commit identity** uses section `commit-identity` and POST `/settings/commit-identity` with `commitAuthorName` and `commitAuthorEmail`. Existing `git-identity` section links and POST `/settings/git-identity` remain valid.

The `update-channel` section is **Update channel**, with **Stable** and **Latest** choices. Its POST endpoint is `/settings/update-channel` with form field `channel=stable` or `channel=latest`. The image tags and saved settings format are unchanged.

The `update` section is **Updates**, the feature for managing AgentsInTheCloud installation Updates. It is separate from Workspace package and agent CLI updates.

Settings is app-level, not configuration for the selected Workspace, a Workspace template, or an individual Agent. Git hosting connections (GitHub, GitLab and Bitbucket) are shared across Workspaces; their tokens are distinct from the Commit identity used to author commits. Connect one with POST `/settings/git-hosting/:provider/connect` (`github`, `gitlab` or `bitbucket`) and form field `token`, plus `account` (the Atlassian account email) for Bitbucket. The settings section is a registered settings contribution ID, such as `theme`, `commit-identity`, `git-hosting`, `models`, `dictation`, or `update`.

## Create and wait for a workspace

Creation is asynchronous and returns `202 Accepted` immediately. The response’s
`workspace.url` and `Location` header are origin-relative paths, like workspace
detail URLs. Resolve them against the public request URL to preserve HTTPS
when AgentsInTheCloud runs behind a TLS-terminating proxy:

```sh
created=$(curl -sS -X POST http://localhost:3000/workspaces \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"source":{"type":"empty"},"title":"Evaluation"}')
id=$(jq -r '.workspace.id' <<<"$created")
```

`source` may be `{ "type": "empty" }` or `{ "type": "workspace-template", "workspaceTemplate": "name-or-id" }`. Optional `agent` fields are `agentTypeId` (Builtin, Claude Code, Claude Code CLI, Codex, Codex CLI, or Pi: `builtin`, `claude`, `claude-cli`, `codex`, `codex-cli`, or `pi`), `initialPrompt`, `model`, `thinkingLevel`, and `attachmentDraft`. For the Builtin Agent, `model` may be any model in a connected provider’s catalogue, enabled or not; a model that can’t run is refused with 400 rather than replaced by the default.

Poll the same UI URL with JSON content negotiation:

```sh
while :; do
  workspace=$(curl -sS -H 'Accept: application/json' "http://localhost:3000/workspaces/$id")
  phase=$(jq -r '.workspace.phase.kind' <<<"$workspace")
  [ "$phase" = runningPhase ] && break
  [ "$(jq -r '.workspace.phase.status' <<<"$workspace")" = failed ] && { jq . <<<"$workspace"; exit 1; }
  sleep .2
done
```

Existing workspaces are discovered before the server starts listening. Each active
workspace then runs its startup checklist in the background with phase `provisioningPhase`.
Workspace preparation checks the ingress and egress gateways and parent sockets, and installs the workspace's
saved Preloaded images. Failure retains the container for repair and presents
**Retry** and **Continue anyway**. Use
`POST /workspaces/:id/provisioning/continue?action=retry` to retry runtime preparation,
or omit the query parameter to explicitly bypass the failure. Bypassing makes the
workspace enter `runningPhase` while retaining its preparation warning. Until startup completes,
the workspace shows its checklist instead of its Agents or Work views. AgentsInTheCloud and
other workspaces remain available throughout.

The list and detail responses include optional `warnings` entries with `kind` and
`message`; running workspace details also include each warning's `title`, `state`, and `action`. Image inspection runs independently at AgentsInTheCloud startup. Workspace preparation
runs again when a workspace resumes or AgentsInTheCloud restarts; bypassing a failure does not
permanently disable checks. Existing workspaces keep their saved preload references
when template settings change.

A running-phase response advertises its `agents`, typed `workViews`, and available `commands` with their `inputSchema`.

## Stage Agents and Work views

**Close Agent** uses `POST /workspaces/:id/agents/:agentId/close`. The transcript is retained, but the closed Agent cannot be reopened or resumed. Starting a fresh Agent session is different: it keeps the same Agent.

Execute commands using their advertised schema:

```sh
curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/terminal.create" \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"title":"Tests","cwd":"/work","command":"bun test"}'

curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/browser.create" \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:3000/"}'

curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/agent.create.claude" \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' -d '{}'
```

`agent.create.<agentTypeId>` creates an Agent of that type and returns its id as `command.agentId`. Plain `agent.create` uses the default type, which is the one the user picked last, so scripts that control the Agent afterwards should name the type.

Navigate an existing Browser view with `POST /workspaces/:id/browser/:browserId/navigate` and `{ "url": "..." }`.

Stage test machines for a Workspace whose template has machine profiles, and an LXD server connected in Settings. A Workspace's machines all go on one server; each machine's `server` says which. Creating one waits up to 4 minutes for it to boot and answers with its `state`. One that's still `creating` or `starting` keeps going; list the machines until it's `ready`. Inside the Workspace, `ssh <name>` reaches it, waiting while it boots. `machines.open` opens the Machines Work view.

```sh
curl -sS -X POST "http://localhost:3000/workspaces/$id/machines" \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"profile":"node"}'

curl -sS "http://localhost:3000/workspaces/$id/machines" -H 'Accept: application/json'

curl -sS -X POST "http://localhost:3000/workspaces/$id/machines/node-1/release" \
  -H 'Origin: http://localhost:3000' -H 'Accept: application/json'
```

## Arrange Work views

Changes uses **Diff endpoints**: a `base` and `target`, with an optional implicit base for a single chosen commit. Existing comparison HTTP fields remain `start` (base) and `end` (target); their behavior is unchanged.

- `POST /workspaces/:id/work-views/reorder` with `key` and `index`
- `POST /workspaces/:id/work-views/close` with a typed `reference`
- `POST /workspaces/:id/work-views/:key/attention/request` to request attention for a Work view without selecting it

Open Work-view identity and order are server-persistent. Workspace, agent, and view `requestingAttention` states are independent and server-persistent; each clears only when that destination becomes visible. Workspace `phase` is an object with `kind` and `busy`, plus phase-specific substates. Agent summaries include `busy` and `requestingAttention`. Active destinations, pane visibility, and Work-pane width are browser-local.

The Agent `/park` message responds with a `307` redirect to the workspace park operation.
Follow same-origin redirects while preserving the POST method, Accept, and Origin headers (for example, `curl -L`).
Confirmation is returned only to that requester; JSON clients receive `409` when confirmation is needed.

Rename with `POST /workspaces/:id/sidebar-title` and `{ "title": "..." }`. Park, unpark, and delete use the corresponding existing workspace UI routes with `Accept: application/json` and a matching `Origin` header.

## Control an agent

Agent control routes live under a path that depends on the Agent's `agentTypeId`:

| `agentTypeId` | `<base>` |
|---|---|
| `builtin` | `/workspaces/:id/agents/:agentId` |
| `claude` | `/workspaces/:id/claude-code-agents/:agentId` |
| `codex` | `/workspaces/:id/codex-agents/:agentId` |

`claude-cli`, `codex-cli`, and `pi` Agents run in a terminal and have no control routes. Give them their first prompt through `agent.initialPrompt` when creating the workspace.

- `POST <base>/model` with `{ "model": "provider::model" }`. Claude Code needs an `anthropic::` model from its catalog and Codex an `openai-codex::` one. Both refuse to switch while working.
- `POST <base>/thinking-level` with `{ "thinkingLevel": "medium" }`
- `POST <base>/messages` with `{ "text": "..." }`
- `POST <base>/abort`

Message submission returns `202 Accepted`; it does not wait for inference to finish. Builtin also accepts `"mode"`: while it works, `"steer"` (the default) joins the running turn, and `"send"` or `"followUp"` waits until it finishes. `POST <base>/queued-inputs/<submissionId>/steer` turns a queued follow-up into steering; on an idle agent, whose turn ended in an error with input still queued, it resumes that queue in order. Claude Code and Codex steer automatically while busy, and run their own slash commands through `messages`: a command that needs more input returns `200` with a `command` result instead. `/openapi.json` lists each type's routes and bodies.

## Present the result

After staging the desired Work view, use the agent's `present` tool with:

```text
http://localhost:3000/workspaces/<id>
```

## Inspect Model provider usage

`GET /usage` with `Accept: application/json` returns all connected providers with
implemented subscription-usage support (OpenAI Codex and Anthropic). Refresh an
individual provider with `GET /usage/providers/openai-codex` or
`GET /usage/providers/anthropic` and the same header. Anthropic requires subscription
OAuth sign-in, not an API key. Its five-hour, weekly, and available model/feature
windows use the same pacing reference. Buckets with no reset timestamp retain
their reported usage, with null reset and timing values and timing state `unknown`.
Null buckets are omitted; monetary extra usage is not a paced allowance, so only
whether it's on, and why not, shows as an `Extra usage` entry in `details`. Anthropic
does not report a plan name or account-wide allowed/limit-reached flags, so these
are null.
In the app, each provider’s usage shows on its card in the Models dialog; the
workspace Usage button opens that dialog with its provider expanded.

Each result includes provider-reported windows, their durations and resets,
and pacing relative to elapsed time. Provider failures populate `error`.
The Usage feature does not record or persist installation-wide token totals.

A provider card groups provider-reported 0% windows under **Unused limits**
(collapsed when there are used limits, expanded when all limits are unused)
and renders reset countdowns such as `3d 12h`. The workspace Usage button traces
Time and Usage for the subscription whose active allowance has the shortest Estimated time to hit limit
among subscriptions used for successful inference in the 30 minutes ending at the
last recorded inference. Limits are checked at display time, not frozen at the time
of that inference. Built-in Agent inference and connected-subscription CLI traffic
through workspace egress contribute activity; API-key traffic does not. Activity is
kept in memory and cleared on credential changes. The button refreshes every minute
while visible, on focus, and whenever a provider card loads fresh limits. No recorded activity or no
available active limits means no comparison ring. Both arcs start at twelve
o’clock and run clockwise on the same circle. Their shared portion is neutral;
Time beyond Usage is green, and Usage beyond Time is red. A dim full-circle
track preserves the button outline beneath the arcs.
Among active windows with nonzero usage, the button selects the shortest
Estimated time to hit limit; ties prefer higher Usage. When all active windows are
unused, the main allowance takes precedence over feature-specific allowances.
Expired/not-started windows and windows with unknown reset timing are excluded.
`GET /usage/button` returns the server-rendered button frame
(or a Turbo Stream with `Accept: text/vnd.turbo-stream.html`).
Each window also includes `timing`: the inferred start (`reset − duration`),
elapsed-time percentage, and usage-minus-time difference in percentage points.
`paceDifferenceSeconds` converts that difference to distance along the allowance
schedule (`paceDifferencePoints / 100 × durationSeconds`). Provider cards and the button
label show compact durations such as `30m ahead of pace` or `1d 4h behind pace`.
Positive means consumption is ahead; negative means behind. This is not time
until exhaustion. Both difference fields are null outside an active window.
**Estimated time to hit limit** is a separate forecast based on average consumption since the window began. It stops at the next reset; **Not before reset** means no hit is projected before then. An unavailable estimate is shown as a dash. Unlike **Resets in**, this is not an actual countdown.

Each provider card shows Time and Usage percentages above one comparison bar per allowance.
Both grow from the left: overlap is neutral, Time beyond Usage is green, and Usage
beyond Time is red. Outside an active window the bar stays neutral. This is a linear pacing
reference, not a billing forecast; pacing is omitted before a window starts or
once its reset is due.

Usage is contributed by the Agent module, including these OpenAPI paths. Its
header action and directly navigable dialog use the generic
[module-owned workspace-pane action interface](workspace-pane-actions.md).
