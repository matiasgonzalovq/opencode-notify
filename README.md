# opencode-notify

> **English** · [Español](#español)

Desktop and push notifications for [OpenCode](https://opencode.ai): tells you when a run finishes, when it needs your approval, when it needs an answer, and when it failed — so you can stop watching the terminal.

Two independent output channels:

| Channel | How | Needs |
| --- | --- | --- |
| **ntfy.sh** | `POST https://ntfy.sh/<topic>` | A topic. Nothing to install. |
| **macOS** | `terminal-notifier` | `brew install terminal-notifier` |

Channels are independent. Set up one or both; a failure in one never affects the other, and neither ever affects OpenCode itself.

---

## What you get

| Event | Notification | Priority |
| --- | --- | --- |
| `session.execution.succeeded` | "Trabajo terminado" | normal |
| `session.idle` / `session.status: idle` (after a run) | "Trabajo terminado" | normal |
| `permission.asked` | "Necesita autorización" | **high** |
| `question.asked` / `form.created` | "Necesita tu respuesta" | **high** |
| `session.error` | "Error" | **high** |

`permission.replied`, `question.replied` / `question.rejected`, `form.replied` / `form.cancelled` and `session.execution.started` never notify — they only clear pending state.

**No premature "done".** A completion is never reported while a permission, a question or an error is still pending for that run. Once you resolve it, completion reporting is re-enabled.

### Event shapes

Shapes were verified against the OpenCode **2.0.20** binary rather than assumed — the `@opencode-ai/sdk` package predates the `form.*` and `session.execution.*` events and does not describe them.

| Event | Request id | Session id |
| --- | --- | --- |
| `permission.asked` | `data.id` | `data.sessionID` |
| `permission.replied` | `data.requestID` | `data.sessionID` |
| `form.created` | `data.form.id` | `data.form.sessionID` |
| `form.replied` | `data.id` | `data.sessionID` |
| `form.cancelled` | `data.id` | `data.sessionID` |
| `session.execution.succeeded` | event `id` | `data.sessionID` |

`form.created` is the one nested event; OpenCode resolves it with an explicit special case in its own source. The plugin matches that shape, so a pending form suppresses **its own** session's completion and does not leak into unrelated sessions.

---

## Install

```sh
# 1. Put the plugin where OpenCode loads plugins from
mkdir -p ~/.config/opencode/plugins
cp plugins/ntfy-notifications.js ~/.config/opencode/plugins/

# 2. macOS only: install the notifier
brew install terminal-notifier

# 3. Configure (see below), then verify
opencode plugin list
```

`opencode plugin list` should show `ntfy-notifications`.

---

## Configuration

All configuration is by environment variable. There is no config file, so no secrets end up in a repository.

| Variable | Required | Description |
| --- | --- | --- |
| `OPENCODE_NTFY_TOPIC` | For ntfy | Your ntfy.sh topic. If unset, the ntfy channel is disabled and only macOS notifications are sent. |
| `OPENCODE_REMOTE_URL` | No | An `https://` URL to your OpenCode instance. Enables a tappable "open" link in the notification. |
| `OPENCODE_NTFY_STATE_DIR` | No | Directory for deduplication state. Defaults to `~/.config/opencode`. |

Put them in your shell profile (`~/.zshrc`) so they are exported to every OpenCode you start:

```sh
export OPENCODE_NTFY_TOPIC="pick-a-long-random-string"
# export OPENCODE_REMOTE_URL="https://opencode.example.com"
```

> **Your topic is a secret.** Anyone who knows it can send you notifications. Pick something long and random, and don't commit it. Notifications never include the topic, the server password, or URL credentials — see [Security](#security).

### Choosing a topic

Visit [ntfy.sh](https://ntfy.sh) and pick a topic name, or run `ntfy publish` with the official client. Subscribe on your phone with the [ntfy app](https://ntfy.sh/#subscribe-phone) and the same topic.

---

## Deduplication

OpenCode delivers one finished execution to **every** plugin instance. Without coordination you would get one notification per instance.

The plugin claims each execution with an **atomic lockfile**: it creates a file named after the SHA-256 of the event id with `O_EXCL` (`wx`), which is atomic on POSIX. The first instance to create the file notifies; every other one gets `EEXIST` and stays silent. This needs no shared in-memory state, so it works across processes.

Records live under `$OPENCODE_NTFY_STATE_DIR/ntfy-seen/` (`0700` dir, `0600` files) and are swept after 7 days. They contain only hashes — no topic, no message, no URL.

Both `session.execution.succeeded` and `session.error` go through this claim, so a failure is also reported exactly once no matter how many plugin instances receive it.

Events **without an id** can't be claimed by hash. Rather than dropping the notification, the plugin falls back to a short time bucket (2 s): bursts inside one run collapse into a single notification, and a later run notifies again. The worst case at a bucket boundary is a duplicate; never a missed notification.

---

## Security

Notifications are built to be safe to receive on a lock screen and safe to publish from a repository:

- The topic appears **only** in the request URL — never in headers or body.
- `OPENCODE_REMOTE_URL` is stripped of credentials, query string and hash before use.
- `OPENCODE_SERVER_PASSWORD` is never read or transmitted.
- Titles are RFC 2047-encoded, so non-ASCII text can't break header parsing.
- Claim records contain SHA-256 hashes only.

See [`SECURITY.md`](SECURITY.md) for details and reporting.

---

## Supported platforms

| Platform | ntfy channel | macOS channel |
| --- | --- | --- |
| macOS | ✅ | ✅ |
| Linux | ✅ | — (skipped cleanly) |
| Windows | ✅ | — (skipped cleanly) |

The macOS channel activates only on `darwin`. Everywhere else it is skipped and ntfy still works.

---

## Development

```sh
npm ci
npm test          # node:test — 31 tests, no dependencies
npm run test:vitest  # vitest — the spec suite
npm run test:all
```

Both suites fully mock `fetch` and `execFile`. **Tests never send a real notification.**

CI runs both suites on Linux and macOS.

### Layout

```
plugins/ntfy-notifications.js   the plugin (single file, no runtime deps)
tests/ntfy-notifications.test.js  node:test unit suite
tests/ntfy-notifications.spec.js  vitest spec suite
```

`createNotificationHandler` accepts injectable `fetchImpl`, `execFileImpl`, `notifierPath`, `platform`, `claimDir` and `now`, which is what keeps the tests hermetic.

---

## Uninstall

```sh
rm ~/.config/opencode/plugins/ntfy-notifications.js
rm -rf ~/.config/opencode/ntfy-seen   # optional: dedup state
```

---

## License

[MIT](LICENSE)

---

# Español

**[English](#opencode-notify)** · Español

Notificaciones de escritorio y push para [OpenCode](https://opencode.ai): te avisa cuando termina una tarea, cuando necesita tu autorización, cuando necesita una respuesta y cuando falló — para que dejes de mirar la terminal.

Dos canales de salida **independientes**:

| Canal | Cómo | Requisito |
| --- | --- | --- |
| **ntfy.sh** | `POST https://ntfy.sh/<topic>` | Un topic. No hay que instalar nada. |
| **macOS** | `terminal-notifier` | `brew install terminal-notifier` |

Configura uno o ambos. Un fallo en un canal no afecta al otro, y ninguno afecta a OpenCode.

## Qué vas a recibir

| Evento | Notificación | Prioridad |
| --- | --- | --- |
| `session.execution.succeeded` | "Trabajo terminado" | normal |
| `session.idle` / `session.status: idle` (tras una ejecución) | "Trabajo terminado" | normal |
| `permission.asked` | "Necesita autorización" | **alta** |
| `question.asked` / `form.created` | "Necesita tu respuesta" | **alta** |
| `session.error` | "Error" | **alta** |

**Sin "terminado" prematuro.** Nunca se reporta una finalización mientras haya un permiso, una pregunta o un error pendiente en esa ejecución.

## Instalación

```sh
mkdir -p ~/.config/opencode/plugins
cp plugins/ntfy-notifications.js ~/.config/opencode/plugins/
brew install terminal-notifier   # solo macOS
opencode plugin list             # debe listar ntfy-notifications
```

## Configuración

Todo por variables de entorno, así no hay secretos en archivos de configuración.

| Variable | Requerida | Descripción |
| --- | --- | --- |
| `OPENCODE_NTFY_TOPIC` | Para ntfy | Tu topic de ntfy.sh. Sin él, el canal ntfy queda deshabilitado. |
| `OPENCODE_REMOTE_URL` | No | URL `https://` a tu instancia. Habilita el enlace para abrir desde la notificación. |
| `OPENCODE_NTFY_STATE_DIR` | No | Directorio del estado de deduplicación. Por defecto `~/.config/opencode`. |

```sh
export OPENCODE_NTFY_TOPIC="elige-una-cadena-larga-aleatoria"
```

> **Tu topic es un secreto.** Cualquiera que lo conozca puede enviarte notificaciones. Elije uno largo y aleatorio y no lo subas a un repositorio.

## Deduplicación

OpenCode entrega cada ejecución terminada a **todas** las instancias del plugin. Para no notificar una vez por instancia, cada ejecución se "reclama" con un **lockfile atómico**: se crea un archivo con el SHA-256 del id del evento usando `O_EXCL` (`wx`), atómico en POSIX. La instancia que lo crea primero notifica; las demás reciben `EEXIST` y guardan silencio. No hay estado en memoria compartido, así que funciona entre procesos.

Los registros viven en `$OPENCODE_NTFY_STATE_DIR/ntfy-seen/` (dir `0700`, archivos `0600`) y se eliminan a los 7 días. Contienen solo hashes.

Tanto `session.execution.succeeded` como `session.error` pasan por este mecanismo, así que un fallo también se reporta exactamente una vez sin importar cuántas instancias del plugin lo reciban.

### Formas de los eventos

Verificadas contra el binario de OpenCode **2.0.20**, no asumidas — el paquete `@opencode-ai/sdk` es anterior a los eventos `form.*` y `session.execution.*` y no los describe.

| Evento | id de la petición | sessionID |
| --- | --- | --- |
| `permission.asked` | `data.id` | `data.sessionID` |
| `permission.replied` | `data.requestID` | `data.sessionID` |
| `form.created` | `data.form.id` | `data.form.sessionID` |
| `form.replied` | `data.id` | `data.sessionID` |
| `form.cancelled` | `data.id` | `data.sessionID` |
| `session.execution.succeeded` | `id` del evento | `data.sessionID` |

`form.created` es el único evento anidado. El plugin respeta esa forma, de modo que un formulario pendiente suprime la finalización **de su propia sesión** y no contamina a sesiones ajenas.

Los eventos **sin id** no se pueden reclamar por hash. En vez de descartarlos, se usa una ventana de tiempo corta (2 s): las ráfagas de una misma ejecución colapsan en una sola notificación y una ejecución posterior vuelve a notificar. El peor caso en un límite de ventana es un duplicado; nunca una notificación perdida.

## Seguridad

- El topic aparece **solo** en la URL de la petición, nunca en cabeceras ni cuerpo.
- `OPENCODE_REMOTE_URL` se limpia de credenciales, query y hash antes de usarse.
- `OPENCODE_SERVER_PASSWORD` nunca se lee ni se transmite.
- Los registros de deduplicación contienen solo hashes SHA-256.

## Plataformas soportadas

ntfy funciona en macOS, Linux y Windows. El canal macOS solo se activa en `darwin`; en el resto se omite limpiamente.

## Desarrollo

```sh
npm ci
npm test              # node:test — 31 pruebas, sin dependencias
npm run test:vitest   # vitest
```

Ambas suites mockean por completo `fetch` y `execFile`. **Las pruebas nunca envían una notificación real.**

## Desinstalar

```sh
rm ~/.config/opencode/plugins/ntfy-notifications.js
rm -rf ~/.config/opencode/ntfy-seen
```

## Licencia

[MIT](LICENSE)
