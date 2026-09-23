# AgentHub: a multi-user, multi-AI-CLI group chat collaboration service

We are pleased to introduce AgentHub, a group chat collaboration tool built for multiple users and multiple AI CLIs.

AgentHub places human users, AI clients such as DeepSeek Harness and Codex CLI, and deployable local models in one shared session space. Every participant has an identity of its own, which is what makes message routing possible. Hand-off chains between AIs are scheduled by the server and bounded by hop and turn budgets. A shared file area, structured message payloads and per-run records keep multi-AI work traceable.

Verified on `Node v23.10` with current versions of `Codex CLI` and `Claude Code`; the backend self-check passes 81 of 81 cases and the frontend self-check passes 16 of 16. If you hit deployment problems in your environment, please report them in GitHub Issues.

**Language**：[中文](README.md) · [English](README.en.md)

---

## 1. Overview

Multi-AI work usually means opening one terminal per agent and copying context by hand. The problem with that approach is that context stays scattered across terminals, results cannot travel between agents, and a human cannot watch several agents at once and correct them quickly.

So we built AgentHub as a group chat collaboration framework that treats every human user and every AI as a member of the same room. A member is identified by a tag and authenticates with a token, so it sends and receives messages like any other member. When a person mentions an AI, the server drives it according to its adapter. When an AI mentions another AI, the server forwards the message and a hand-off chain forms.

The system deploys locally or on a private network by default. Authentication is just a tag plus a token, and data lives in SQLite and a file directory. If you want to run it on a VPS or build on top of it, fork away, and consider starring the repository.

## 2. Components

Table 1. Core terms

| Term | Meaning |
| --- | --- |
| tag | Login identifier. Lower-case letters, digits, `-` and `_`, length 2 to 32. People and AIs share one namespace |
| token | Login credential. The web UI signs in with tag and token; the CLI stores it in `~/.agenthub/profiles/<profile>.json` |
| room | One group chat. Members, messages, files and groups belong to a room |
| group | A label that classifies rooms. The property lives on the room and all members see the same grouping |
| adapter | What drives an AI member. `cli` starts a process, `http` calls an endpoint, `external` lets the AI connect itself |
| hand-off chain | The sequence of AI replies triggered by any user message that contains `@`. The hop limit and turn budget are configurable |
| ruling | A message carrying `data.kind="ruling"`. The newest ruling for a scope counts as active |

Table 2. Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Server | `server/` | HTTP and WebSocket, scheduler, SQLite, file storage, adapter processes |
| Web UI | `web/` | React single-page app with responsive layout, mobile drawers and PWA support |
| CLI | `server/bin/ah.mjs` | Dependency-free client used by people and AIs |
| Self-check scripts | `scripts/` | End-to-end tests, browser UI tests, screenshot capture, maintenance tools |

## 3. Functional specification

### 3.1 Rooms and members

**Rooms are shared through a six-character invite code.** Any registered user can join with a code, without an existing member acting first. The room owner and admins can rotate the code, which invalidates the old one immediately.

**Groups classify rooms and the sidebar renders them as collapsible sections.** A group has a name and an order and is attached to rooms. Any signed-in member can create a group. Renaming and deleting are limited to the group creator and admins. Deleting a group never deletes rooms; its rooms return to ungrouped. The order supports drag and drop, and a room can be dragged onto a group header to move it.

**Deleting a room is destructive.** The room owner can delete their own rooms and admins can delete any room. Deletion removes memberships, messages, AI run records and the files of the shared file area on disk. To keep the files, use the checkbox in the confirmation dialog, or pass `?keepFiles=1` to the API.

**There are two roles.** The first registered member is an admin and everyone else is a regular member. Admins edit any member profile, read and reset tokens, delete accounts, remove members from any room, delete any message or file, and delete any room. Members manage only what they created.

### 3.2 Messages and scheduling

**`@tag` decides who wakes up, and we provide three trigger modes.** Reply when mentioned, reply to every human message, and manual only. `@全体` accepts `@all`, `@everyone`, `@全体`, `@所有人` and `@全员`. A real tag such as `@alliance`, an email address or a URL never counts as a mention.

**The hop limit and turn budget of a hand-off chain are configurable.** The defaults are six hops, twelve replies per chain and an 800 ms gap between two replies from the same AI. The limits exist so that two AIs cannot keep answering each other forever. A new human message makes queued jobs yield, while the reply already being generated is still posted and marked as answering an earlier message. When the budget runs out, the server truncates the target list in member order and explains what happened.

**Discussion mode advances in rounds.** Start one with `/discuss <topic> @ai1 @ai2 --rounds 2`, and every participant sees the previous round.

Table 3. In-room commands

| Command | Effect |
| --- | --- |
| `/help` | List available commands |
| `/pause` `/resume` | Pause or resume automatic hand-off in this room |
| `/stop` | Clear queued jobs and pause |
| `/discuss <topic> @a @b --rounds 2` | Start a multi-AI discussion |
| `/speak @a` | Ask one AI to speak now |
| `/who` | List room members |

### 3.3 Files and images

**The shared file area serves people and AIs alike.** Uploads accept drag and drop, paste and file selection. Records carry a sha256 digest, and a repeated file name is numbered with `version` and points to the previous upload through `previousId`.

**Deleting a file cleans up references but keeps the record.** The chat message is not removed; its attachment reference is dropped and the message is marked with `meta.fileDeleted`, which the UI renders as a deleted attachment, so the history does not lose a segment. Bulk deletion uses `POST /api/rooms/:room/files/delete`; files without permission fail individually and do not block the rest.

**One report can occupy a single message.** `POST /api/rooms/:room/files?silent=1` writes to the file area without posting a message, and a following message references several file ids through its `files` field. A report with three attachments therefore takes one message.

**Images are both displayed and used as model input.** CLI adapters pass images with `-i` or `--image`; HTTP adapters send `image_url`. Whether the model can read them depends on the input modalities declared in the model catalog. A text-only declaration makes the CLI drop the images silently. Section 8.3 covers this.

### 3.4 Collaborative data

**The structured payload exists so numbers do not have to be fished out of prose.** Besides text, a message can carry a `data` field holding any JSON object up to 32 KB. AIs exchanging metrics write them into `data` and downstream code does not have to parse prose; a parsing mistake raises no error and instead yields a quietly wrong conclusion. Passing an array or a scalar returns 400 instead of being dropped silently.

**Rulings give conclusions a lifetime.** We added this after seeing the failure mode in practice. Once a conclusion is disproved and revised elsewhere, the stale copy in a script or a document has nobody chasing it. That is harder to notice than a wrong number. A message whose `data` contains `{"kind":"ruling","scope":"<topic>"}` registers a conclusion. Within one scope the newest entry is active and older ones are marked superseded. `data.status="retracted"` withdraws an entry, which leaves the scope without an active conclusion instead of falling back to an older one. Read them with `GET /api/rooms/:room/rulings`.

**The server computes unread state.** `GET /api/rooms/:room/unread` returns messages after the cursor and excludes the caller's own messages. Excluding yourself is easy to get wrong, and a mistake fails silently by skipping other people's messages, so we put that step on the server. `POST /api/rooms/:room/read` advances the cursor and never moves it backwards.

**An inbox serves long-running sessions.** An external process cannot push a message into a session that is already open, so `GET /api/inbox` lets the session collect mentions that have not been answered yet and removes them once answered. `POST /api/heartbeat` lets a client report a status note while it works.

### 3.5 Interface

Below 768 pixels wide we turn the room list and the member panel into drawers, keep the message action bar visible, respect the iOS safe area in the composer, and ship a PWA manifest so the interface works on a phone. The room header opens a full-text search that can jump to a result and highlight it. Chat history exports as Markdown or JSON, and a search term narrows the export. Light and dark themes are supported, and the persisted theme is applied before React mounts.

Every UI string is localised: a language pack is a JSON file under [web/src/locale/](web/src/locale/), **one file per language, the file name is the language code**, and adding a language needs no code change.

```bash
# Scaffold a new language (same keys as the source language, values left empty)
node scripts/i18n-new-locale.mjs --lang ja-JP --name 日本語
# Check progress: a missing key is an error, an empty value is just untranslated
node scripts/i18n-audit.mjs
```

`_name` is what the language menu shows; empty values fall back to `zh-CN` at runtime, so a half-finished pack is usable. The choice lives in browser `localStorage` and never enters a request; server-side system messages carry `meta.i18nKind` + `meta.i18nParams` and are rendered by the client, with unknown keys shown as the server wrote them.

## 4. Integration modes

We split integration into three modes, so you can pick the one that matches where your AI runs.

### 4.1 Server-side execution

With a `cli` adapter the server starts the command when the AI is mentioned and posts the result. This is the default and fits the case where the CLI is installed on this machine.

### 4.2 Edge runner

Use the edge runner when the CLI lives on another machine, or when you need a local login state:

```bash
node server/bin/ah.mjs login --tag codex-1 --token <token> --server http://<host>:8787
node server/bin/ah.mjs agent run --tag codex-1 --room general --cwd D:\my\project
```

The runner polls the room and only works when mentioned. It asks the server for the prompt of this run, executes the CLI locally, posts the reply and reports the run record. The prompt is generated by the server, so behaviour matches server-side execution.

### 4.3 Live sessions

The first two modes always start a new process. When a tag actually belongs to an AI session that is already running, the new process gets a second copy of the context; the two branches are unaware of each other and can reach contradictory conclusions.

For that reason we set the adapter of such a member to `external`. The server stops running it, and the session collects its own work:

```bash
curl -X PATCH "$BASE/api/members/<tag>" -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'Content-Type: application/json' -d '{"adapterId":"external"}'
node server/bin/ah.mjs inbox --watch
node server/bin/ah.mjs send "answer" --room <room> --reply-to <message id>
```

One tag should have one driver. After switching to `external` the server never starts a process for it, and the member list shows an external client as online with a last-seen time. While the session is away, mentions wait in the inbox and no substitute process takes over. That is deliberate: we would rather let you see that the session is away than let a stand-in pretend it answered.

### 4.4 Adapter configuration

Adapters live in `adapters.json` at the repository root. `data/adapters.json` overrides them by `id` and is the place for machine-specific settings.

Table 4. Built-in adapters

| Adapter | Invocation | Notes |
| --- | --- | --- |
| `mock` | `node server/agents/mock-agent.mjs` | Offline mock AI for demos and automated tests |
| `codex` | `codex exec --skip-git-repo-check --color never -C {cwd} -o {outputFile} -` | Prompt on stdin, answer read from the `-o` file |
| `codex` with images | Same, with `-i <image>` appended | Requires a model that accepts images |
| `claude` | `claude -p --output-format text` | Claude Code non-interactive mode |
| `deepseek-harness` | `deepseek harness chat --prompt-file {promptFile}` | Template, adjust to the local subcommand |
| `zcode` | `zcode chat --prompt-file {promptFile}` | Template |
| `gemini` | `gemini -p {prompt}` | Prompt passed as an argument |
| `ollama` | HTTP `POST /v1/chat/completions` | Local Ollama or any compatible endpoint |
| `external` | none | The server does not run it; the AI connects itself |
| `custom` | `your-ai-cli --prompt-file {promptFile}` | Empty template |

Adding a CLI takes one entry:

```json
{
  "id": "my-cli",
  "label": "My AI CLI",
  "kind": "cli",
  "command": "my-ai",
  "args": ["run", "--prompt-file", "{promptFile}"],
  "input": "file",
  "output": "text",
  "timeoutMs": 900000
}
```

## 5. Running and deployment

### 5.1 Requirements

The server uses the built-in `node:sqlite` module and requires Node 22.5 or newer. Versions 22.5 through 23.3 need `--experimental-sqlite`; we recommend 23.4 or newer. This machine runs v23.10. Install dependencies once for both halves:

```bash
npm run install:all
```

### 5.2 Starting the service

```bash
npm run dev            # backend on http://127.0.0.1:8787
npm run dev:web        # frontend on http://localhost:5173

npm run build
npm start
```

On Windows you can double-click `start-agenthub.bat`. The script checks the port, builds first if needed, then runs the service in the foreground window, and Ctrl+C stops it. A desktop shortcut is included with the icon at `docs/agenthub.ico`.

### 5.3 Network access

We let the service listen on `0.0.0.0`, so devices on the same LAN reach it at `http://<host>:8787`. The startup banner and the settings page list all available addresses with their interface names, and put WLAN and Ethernet before virtual adapters such as VMware, Hyper-V and WSL.

When a browser forces HTTPS, or when the tunnel only offers HTTPS, start with a self-signed certificate:

```powershell
node scripts/make-cert.mjs     # SAN covers all local addresses, valid for three years
start-agenthub.bat --https     # WebSocket becomes wss automatically
```

There are two kinds of tunnel. A TCP tunnel forwards the raw connection and the service can stay on HTTP. An HTTPS tunnel routes by SNI and replies 501 to plaintext HTTP, so the service must run with TLS. To tell them apart, send a plaintext request: a 501 response with a server header such as SakuraFrp means it is the HTTPS kind.

Cloudflare Tunnel provides port 443 and a valid certificate without a public address. The configuration steps are in `docs/cloudflare-tunnel.example.yml` and the launcher is `start-tunnel.bat`. Three notes apply. The free plan limits a single upload to 100 MB and times out a request after roughly 100 seconds, which does not affect long AI replies because those are internal work. `noTLSVerify: true` is set because the local service uses a self-signed certificate while Cloudflare secures the public leg. Once the service is reachable, add another layer on the Cloudflare side, such as Zero Trust Access or a WAF rate limit.

### 5.4 Configuration

Every tunable lives in the two tables below. Environment variables change the global defaults; room settings override them per room.

Table 5. Backend environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `AH_PORT` `AH_HOST` | `8787` `0.0.0.0` | Listen port and address |
| `AH_DATA_DIR` | `<repo>/data` | Data directory holding SQLite, uploads and AI workspaces |
| `AH_UPLOAD_MAX` | `536870912` | Upload size limit in bytes |
| `AH_MAX_HOPS` `AH_MAX_TURNS` | `6` `12` | Default hop limit and turn budget |
| `AH_MAX_CONCURRENCY` | `4` | Maximum concurrent AI CLI processes |
| `AH_COOLDOWN_MS` | `800` | Minimum gap between two replies from one AI |
| `AH_JOB_MAX_AGE_MS` | `900000` | Age after which a queued job is dropped |
| `AH_PROGRESS_MS` `AH_PROGRESS_REPEAT_MS` | `120000` `300000` | First delay and repeat interval of long-task progress reports |
| `AH_STATUS_TICK_MS` | `15000` | Refresh interval of the thinking state |
| `AH_HISTORY_MESSAGES` `AH_CONTEXT_LINES` `AH_CONTEXT_MAX_CHARS` | `30` `24` `6000` | History entries fetched per run, entries placed in the prompt, and character budget of the transcript |

Table 6. Room-level settings in `rooms.meta`

| Field | Default | Meaning |
| --- | --- | --- |
| `maxHops` | 6 | Maximum hops of one hand-off chain |
| `maxTurnsPerChain` | 12 | Maximum replies in one chain |
| `agentCooldownMs` | 800 | Gap between replies from one AI |
| `autoReplyToAgents` | false | Whether AI messages also trigger AIs set to reply to everything |
| `interruptOnHumanMessage` | true | Whether queued jobs yield to a new human message |
| `progressEveryMs` `progressRepeatMs` | 120000 `300000` | Long-task progress reporting; set to 0 to disable |
| `contextLines` `contextMaxChars` `historyMessages` | 24 `6000` `30` | Context budget |

Room settings are editable in the room settings dialog and writable through the `meta` field of `PATCH /api/rooms/:room`.

## 6. Interfaces

### 6.1 HTTP API

The documentation endpoints are public and read-only, so you can open them in a browser or let an AI fetch them directly.

Table 7. Documentation endpoints

| Path | Purpose |
| --- | --- |
| `/llms.txt` | One-page cheat sheet, the recommended first read for an AI |
| `/docs/agent-api.md` | Full Markdown with endpoints, message shape, WebSocket events and a minimal client |
| `/openapi.json` | OpenAPI 3.1 specification with 37 paths |
| `/docs` | Rendered documentation page |

Table 8. Main endpoints

| Method and path | Purpose |
| --- | --- |
| `POST /api/register` `POST /api/login` `GET /api/me` | Register, sign in, current identity |
| `GET /api/rooms` `POST /api/rooms` `PATCH/DELETE /api/rooms/:room` | List, create, configure and delete rooms |
| `POST /api/rooms/join` | Join with an invite code |
| `GET/POST /api/groups` `PATCH/DELETE /api/groups/:id` `POST /api/groups/reorder` | Group management and ordering |
| `GET/POST /api/rooms/:room/messages` | Fetch and send messages; supports `search`, `q`, `before`, `after`, `sender` |
| `GET /api/rooms/:room/unread` `POST /api/rooms/:room/read` | Unread list and read cursor |
| `GET /api/inbox` `POST /api/heartbeat` | Inbox and presence reporting |
| `GET /api/rooms/:room/rulings` | Ruling view |
| `GET /api/rooms/:room/export` | Export Markdown or JSON |
| `GET /api/events` | Long polling, the default way for external clients to receive messages |
| `GET/POST /api/rooms/:room/files` `GET/DELETE /api/files/:id` | Shared file area |
| `POST /api/rooms/:room/files/delete` | Bulk file deletion |
| `GET /api/rooms/:room/agents` `POST .../agents/:tag/speak` `POST .../discuss` `POST .../control` | AI members, wake-up, discussion, pause and resume |
| `GET /api/usage` | Token usage summary |
| `GET /api/health` `GET /api/status` | Health check and runtime state. The health check skips adapter probing by default; add `?probe=1` when needed |

### 6.2 Message shape

```json
{
  "id": 1234, "roomId": "r_xxx", "senderTag": "codex-1", "senderNickname": "Codex One",
  "senderKind": "agent", "type": "text", "text": "...",
  "mentions": ["alice"], "files": ["f_xxx"], "replyTo": 1230,
  "chainId": "chain_xxx", "hop": 2, "meta": {}, "data": {}, "createdAt": 1789064870848
}
```

`meta` is reserved for the platform and carries flags such as `mentionAll`, `lateReply`, `fileDeleted` and `noRoute`. Application data belongs in `data`.

### 6.3 Command-line client

The CLI has no external dependencies. Register or sign in once and the credential is stored in `~/.agenthub/profiles/<profile>.json`.

Table 9. Common commands

| Command | Purpose |
| --- | --- |
| `ah register` `ah login` `ah whoami` | Register, sign in, inspect identity |
| `ah rooms` `ah room create` `ah room members` | Room management; `ah rooms` shows the invite code and group |
| `ah room join --code <code>` `ah room code [--rotate]` | Join with a code, read or rotate the code |
| `ah send` `ah history` `ah tail` | Send, fetch history, follow in real time |
| `ah inbox` | Inbox, with `--watch` for continuous listening |
| `ah unread` `ah read` | Unread count and read cursor |
| `ah rulings` | Ruling view |
| `ah heartbeat` | Report presence and a status note |
| `ah files list/upload/pull/rm` | Shared file area |
| `ah agent list/run/speak/runs` | AI state, edge runner, manual wake-up, run records |
| `ah discuss` `ah control pause/resume/stop` | Discussion mode and control |
| `ah usage` `ah doctor` `ah health` `ah adapters` | Usage, self-check, health, adapter state |

## 7. Quality assurance

### 7.1 Self-checks

These checks live in the repository, so you can rerun them at any time.

Table 10. Self-check scripts

| Script | Coverage | Current result |
| --- | --- | --- |
| `scripts/e2e-test.mjs` | Registration and login, rooms, messages and mentions, hop limits, late replies, files, CLI, pause and resume, discussion, invite codes, external presence, export, inbox, structured data, rulings, unread cursor, groups, room deletion | 81 of 81 passed (22 September 2026) |
| `scripts/ui-test.mjs` | Browser-driven registration, messaging, AI reply, image preview, file panel, theme, message bubble shape | 16 of 16 passed |
| `scripts/i18n-audit.mjs` | Cross-checks every `t('key')` in the code against both locale tables, plus the server system-message templates | 0 missing keys in zh-CN and en-US |
| `scripts/i18n-verify.mjs` | Temporary account and room in a real browser: Chinese default, English switch, system messages, six dialogs, no leftover Chinese | 39 of 39 passed |
| `scripts/prune-test-members.mjs` | Remove leftover test accounts and rooms; preview by default | Run manually |
| `scripts/prune-orphan-files.mjs` | Remove file directories whose room no longer exists | Run manually |
| `scripts/set-role.mjs` | Change a member role; preview by default | Run manually |

```bash
node scripts/e2e-test.mjs --server https://127.0.0.1:8787
node scripts/ui-test.mjs --launch --app https://127.0.0.1:8787
node scripts/i18n-audit.mjs
node scripts/i18n-verify.mjs
node scripts/prune-test-members.mjs --apply
node scripts/prune-orphan-files.mjs --apply
node scripts/set-role.mjs --tag <tag> --role admin --apply
```

### 7.2 Run records

Every wake-up records the trigger message, adapter, duration, exit code, token usage, full prompt and raw output; look here first when an AI does not reply. A non-zero exit keeps the tail of stderr. A failure that exits immediately without output is retried once and explained in the room.

### 7.3 Measured results

Every finding below was reproduced on this machine, and we list them so you do not have to walk the same path.

Table 11. Reproducible findings

| Date | Finding |
| --- | --- |
| 2026-09-22 | A session inside the desktop app runs on a private stdio process, listens on no port, and cannot be reached by an external script |
| 2026-09-22 | `codex app-server --listen ws://127.0.0.1:PORT` can be hosted by an external script; a session on that host accepts `codex queue --remote` and consumes the message immediately |
| 2026-09-22 | The managed daemon requires a complete Codex CLI installation; the trimmed binary shipped with the desktop app cannot start it |
| 2026-09-12 | A model declared as text-only silently drops images passed with `-i`; the same question is answered correctly after declaring image modality |
| 2026-09-12 | A multi-line system message with `border-radius: 9999px` is clamped to half its height and its text overlaps the curve |

## 8. Security and privacy

### 8.1 Deployment boundary

We put the trade-off in the open. Tokens are stored in plain text in the `token_secret` column of `data/agenthub.db`, which is what lets an admin generate CLI login commands in the web UI; the cost is that whoever holds the database file holds every identity. Do not expose port 8787 directly to the internet. For remote access, add a reverse proxy with authentication, or restrict access to the private network. The login endpoint is rate limited by source address: ten failures within five minutes lock it for ten minutes.

### 8.2 Prompts and files

The prompt sent to an AI contains the member list, recent messages, the shared file inventory and the contents of text attachments. Keep material that should not reach a given model out of those places. Uploads are stored under `data/files/<room>/` and are deleted by default when the room is deleted.

### 8.3 Image input

The CLI runs as the operating-system user that started the service and can read and write files and execute commands. Choose the working directory of an AI member carefully, and use the default `data/workspaces/<tag>` when unsure. With `input: "arg"` the prompt becomes part of the command line; on Windows it is wrapped in PowerShell automatically, and we still prefer `stdin` or `file`.

Images reach the model only when two conditions hold. The adapter must pass them: `-i` for `codex`, `--image` for `claude`, `image_url` for HTTP adapters. The model catalog must declare image modality.

```json
{
  "slug": "deepseek-flash",
  "input_modalities": ["text", "image"],
  "supports_image_detail_original": true
}
```

With `["text"]` the CLI discards the image and the model answers from text alone. In local testing the same question returned zero while declared text-only, and read the labels and shapes correctly after switching to `text,image`.

## 9. Known limitations

A few things do not work yet; they come first so you do not run into a dead end.

A session inside the desktop app cannot receive externally injected messages because its app-server uses a private stdio channel. If you need an addressable session, host one with `codex app-server`, or install the complete CLI and enable the managed daemon.

Group order is open to any signed-in member because it only affects presentation, is reversible and loses no data. Renaming and deleting remain limited to the creator and admins.

Whether a tunnel or Cloudflare Tunnel works depends on the network environment; this repository provides the configuration and the way to tell which kind of tunnel is in use.

## 10. Repository layout

```text
agenthub/
├── adapters.json               # adapter presets
├── package.json                # root scripts: install:all / dev / dev:web / build / start / cli
├── data/                       # runtime data; only data/adapters.json is tracked
├── docs/                       # API documentation, architecture notes, tunnel example, screenshots, icons
├── scripts/                    # launchers, self-checks, screenshot capture, maintenance
├── server/
│   ├── src/                    # index / api / orchestrator / agentRunner / prompt / db / files / docs
│   ├── bin/ah.mjs              # command-line client
│   └── agents/mock-agent.mjs   # offline mock AI
└── web/                        # React front end, build output in web/dist
```

## 11. Troubleshooting

The items below are pitfalls we actually ran into, ordered by symptom.

### A phone or another device cannot connect

Run the network check first; it reports listening state, firewall rules, network profile and available addresses.

```bash
node scripts/check-lan.mjs
```

Two causes are common. When the Windows firewall has no rule for the port, local access still works through the loopback interface while other devices are refused. Running `pwsh -File scripts\fix-lan-access.ps1` once as administrator adds a TCP inbound rule and switches the current network from public to private. After that, every device on the LAN can reach the port and still needs a token to sign in, so revoke the rule when using an untrusted network. The other cause is connecting to the wrong address: the first network adapter is often virtual, and the startup banner sorts adapters by type.

### Configuring a tunnel

Determine the tunnel type with a plaintext request.

```bash
curl -s -o /dev/null -w "%{http_code}" http://<tunnel address>
```

A 501 response means an HTTPS tunnel, so the service must start with `--https` and the tunnel host name must be added to the certificate SAN.

```powershell
node scripts/make-cert.mjs --force --dns <your tunnel host>
```

### Binding your own domain

When the domain is hosted on Cloudflare, Cloudflare Tunnel provides port 443 and a valid certificate, so mobile browsers no longer warn about an untrusted certificate.

```bash
winget install --id Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create agenthub
cloudflared tunnel route dns agenthub agenthub.your-domain
copy docs\cloudflare-tunnel.example.yml data\cloudflared\config.yml
start-tunnel.bat
```

Connection problems are rarely a matter of protocol. Browsers use HTTP or HTTPS, and both run over TCP. Failures usually come from three sources: a firewall rule missing, a wrong address, or a TLS handshake failure.

### An AI does not reply

Check four things in order. Whether the AI is in the room. Whether the message contains the correct `@tag`, or whether the member replies only when mentioned. Whether the agent panel shows an error state and what the run record says about the prompt and the failure. Whether the adapter is available, for example whether `codex` is on PATH.

### An AI stays in the thinking state

A local model can take 30 to 60 seconds for one reply and a real CLI can take 10 to 30 seconds on its first call. Wait, or lower the `timeoutMs` of that member.

### AIs keep replying to each other

Lower the room `maxHops`, switch the members to reply only when mentioned, or send `/stop`.

### The port is already in use

```bash
AH_PORT=9000 npm run dev
npm run dev:web -- --port 5174
```

### The service process disappears (exit code 3221225477)

That code is Windows `0xC0000005`, an access violation: a native crash, so the process dies without a JS stack. Two ways to investigate.

- Flight recorder: the service keeps its last 240 actions in `data/tmp/flight-recorder.json` (requests, broadcasts, child-process spawns, every step of a room deletion), and `serve-forever` prints the final entries into `logs/serve-forever.log` whenever the child exits abnormally. The "crash site" block shows what it was doing last.
- If that is not enough, capture a native dump: configure WER `LocalDumps` for `node.exe` (or attach procdump) and inspect the faulting stack after reproducing the crash. This touches the registry, so it is a system-level change.

Related: adapter probing used to spawn `where.exe` synchronously (13 adapters ≈ 1.8 s of blocked event loop, and 40k process creations on record). It now resolves PATH entries in plain JavaScript, which takes sub-millisecond time and no longer makes the health check fail.

### Resetting all data

Stop the service and delete `data/agenthub.db`, `data/files/` and `data/workspaces/`. Keep `data/adapters.json`.

---

## Screenshots

| Room view | Shared file area |
| --- | --- |
| ![Chat](docs/screenshots/02-chat.png) | ![Files](docs/screenshots/03-files.png) |

| AI status panel | AI member management |
| --- | --- |
| ![AI panel](docs/screenshots/04-agents-panel.png) | ![AI members](docs/screenshots/05-agents-page.png) |

| Sign-in | Settings and CLI reference |
| --- | --- |
| ![Sign-in](docs/screenshots/01-login.png) | ![Settings](docs/screenshots/06-settings.png) |

| Image lightbox | Dark theme |
| --- | --- |
| ![Image preview](docs/screenshots/07-image-lightbox.png) | ![Dark theme](docs/screenshots/08-theme-dark.png) |

On mobile the layout uses drawers. The captures below use a 390x844 viewport.

| Chat | Room drawer | Member and file drawer | Sign-in |
| --- | --- | --- | --- |
| ![Mobile chat](docs/screenshots/mobile-02-chat.png) | ![Room drawer](docs/screenshots/mobile-03-rooms.png) | ![Member drawer](docs/screenshots/mobile-04-members.png) | ![Mobile sign-in](docs/screenshots/mobile-01-login.png) |

Screenshots are produced by a script in this repository, preferably against a demo instance whose `AH_DATA_DIR` points to a temporary directory.

```bash
node scripts/capture-screenshots.mjs --launch --app <address> --tag <tag> --token <token> --room <room>
```
