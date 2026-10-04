# Personal clients and shared app servers

Run the browser UI with a local Node client on each person's computer. That client owns its ChatGPT credentials and chat history. Connect it to one or more app servers in Settings using a URL and an owner or guest key. Home combines local apps and accessible remote apps, labelled by server. Servers do not contact one another.

The app server is a separate HTTP process with an intentionally small `/v1` API. It stores app code, SQLite records, shared photos, notifications and owner build drafts. It never loads ChatGPT credentials or runs inference. The local client calls OpenAI directly and forwards app tool calls using only that server's key. It does not forward browser cookies or OpenAI tokens. Redirects are rejected. The browser never receives stored server keys from the connection catalog.

This is a local Node client plus browser UI, not a remotely hosted multi-user website or a browser-only OAuth client. Do not expose the local UI port on a VPS. A phone-only client is not implemented.

## Roles

Both keys are secret bearer credentials. There are no usernames, individual guest identities, or per-action permissions yet.

| Operation | Owner | Guest |
| --- | --- | --- |
| List/open private apps | Yes | No |
| Use shared app actions and records | Yes | Yes |
| Upload/read shared app photos | Yes | Yes |
| Read/write shared app reminders | Yes | Yes |
| Read backend source or build drafts | Yes | No |
| Change code, tests, chat instructions, restore versions | Yes | No |
| Change app visibility, rotate guest key | Yes | No |

Apps default to private. Sharing is per app/space and includes all its records, photos and notifications. Shared data is collaborative, not a separate copy per person. Modern app writes go through validated backend actions; legacy storage-only apps retain their record SDK. The frontend bundle must be delivered to render the app, so it is visible to anyone allowed to use it. Backend source, test reports, drafts and owner conversations are not sent to guests. Guest AI receives app-authored guidance, approved tools and scoped app data, not owner source.

Access is checked on every server request, including tool execution, photo reads, history restores and guessed IDs. Hiding controls in the UI is not authorization. Changing an app back to private blocks subsequent guest requests, including previously fetched tool definitions. Key rotation revokes the previous key for subsequent requests. It cannot erase data already downloaded or cancel actions already accepted.

Chat history is local to each client. There is no shared transcript endpoint. Owner build sessions persist drafts on the app server; their session IDs are not guest credentials. Notifications and read state are shared between people with access to an app in this first version.

## Running a server

Install the repository dependencies with `npm ci`. Use the same Linux/Node/Bubblewrap requirements as local backend execution. No ChatGPT account is needed on the server.

```sh
APP_DATA_DIR=/path/to/server-data APP_SERVER_HOST=127.0.0.1 APP_SERVER_PORT=5175 npm run server:start
```

On first start, the server generates owner and guest keys, stores only their hashes in its database, and writes initial raw keys to `server-keys.json` inside that private data directory (mode 0600). Copy the keys to a password manager and remove the bootstrap file when no longer needed. The file is a one-time bootstrap, not a live view of keys after rotation.

`APP_ORIGIN` is for the local client/OAuth callback; it is not the app server's public URL. Keep the server on loopback behind an HTTPS reverse proxy on a VPS. Proxy requests to its port, allow photo bodies up to 9 MiB, and allow a two-minute request timeout for builds. Expose only this API process, not the local UI process, filesystem, or diagnostics directory. Set the public HTTPS origin as the connection URL in the local client. Plain HTTP connections are accepted only for loopback addresses.

To share the existing local workspace while experimenting, `npm run server:local` installs and starts the user service `little-spaces-app-server.service` on port 5175, using `.data`. The local client stays on port 5173. Settings can change local sharing and issue/rotate local keys. External owner connections can manage sharing and rotate guest keys. Rotate an owner key on its server (or through that machine's local Settings). Existing connections using a rotated key must reconnect with the new one.

Server connections store their secret keys in the client's private workspace SQLite file, alongside its existing private data. A client installation is for one OS user. Keep separate data directories/clients for different people. The home launcher fetches fresh remote catalogs and displays a connection error instead of stale inaccessible apps. Disconnect removes the connection credential; local conversation history remains on disk, but its app mapping cannot make requests without that connection.

## API shape

All endpoints require `Authorization: Bearer <server-key>`. There is no cookie login and no CORS exposure for browser callers; the local Node client is the transport.

- `GET /v1/catalog`: caller's role and accessible apps.
- `GET /v1/spaces/:id`: role-filtered app context.
- `GET /v1/spaces/:id/document`: sandbox document; versions only for owners.
- `GET/POST /v1/spaces/:id/actions`: schemas and action execution.
- `GET/POST /v1/spaces/:id/tools`: scoped AI tools. Owner builds include a UUID session; execution rechecks role and visibility.
- `POST /v1/spaces/:id/context`: validate app chat launch references and resolve live records.
- `GET/POST /v1/spaces/:id/photos`, `GET /photos/:photoId`: shared app media.
- `GET/POST /v1/spaces/:id/notifications`: scoped reminders.
- `GET/POST /v1/notifications`: visible reminders and read acknowledgements.
- `POST /v1/spaces/:id/sharing`, `/restore`, and `POST /v1/keys`: owner operations.

The client has no generic forwarding endpoint: its proxy maps app IDs to stored server connections and permits only known operations. Its existing loopback session and same-origin checks protect connection management and local keys.

## Verification

Access tests cover default-private behavior, guessed IDs, data actions, direct builder and restore attempts, filtered notifications, owner draft publication and key rotation. Client tests verify distinct IDs across servers, guest inference using the client's token, app requests carrying only their server key, and rejection after visibility revocation/disconnection. Generated app tests still run in the existing sandbox, with revision and record conflict checks.
