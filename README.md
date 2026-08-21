# SillyTavern-nat20

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) UI extension that
talks to `nat20-bridge`, a localhost FastAPI sidecar around the
[nat20](https://github.com/tapestria/nat20) SRD 5.2 rules engine. It lets a
SillyTavern chat resolve real 5e combat mechanics (attacks, checks, saves,
spellcasting, etc.) instead of relying on the LLM to freehand dice math, and
narrates the results back into chat.

This repo is **only** the browser-side extension. It does not ship, install,
or configure the bridge itself — the bridge is a separate process you start
yourself (see below). There is no SillyTavern server-plugin involved and no
`config.yaml` changes are required; this is a pure client-side extension plus
an external sidecar it calls over HTTP.

## Install

1. In SillyTavern: **Extensions → Install extension**, paste this repo's git
   URL (`https://github.com/tapestria/SillyTavern-nat20`), and install.
2. Start the bridge in a terminal (it must be running before you use the
   extension):

   ```bash
   uvx nat20-bridge
   # or
   uv tool run nat20-bridge
   ```

   Useful flags:

   | Flag | Default | Purpose |
   | --- | --- | --- |
   | `--host` | `127.0.0.1` | Interface to bind |
   | `--port` | `8020` | Port to bind |
   | `--data-dir` | (bridge default) | Directory for homebrew/session data |

3. In SillyTavern, open **Extensions → Nat20 Rules Engine** and confirm the
   **Bridge URL** matches where you started the bridge (default
   `http://127.0.0.1:8020`), then click **Test connection**. A green status
   line showing `bridge <ver> · engine <ver> · data <ver>` means you're
   connected.

## Command reference

Populated as slash commands land (Task 14).

| Command | Description | Status |
| --- | --- | --- |
| _(none yet)_ | | |

## Settings

- **Bridge URL** — base URL of the running `nat20-bridge` process.
- **Homebrew JSON** — pick a category (items, monsters, spells, species,
  classes, subclasses, backgrounds, feats, features), paste the raw entry
  JSON, and click **Import homebrew** to `POST` it to
  `/v1/homebrew/{category}` on the bridge. Success shows the returned slug;
  failure shows the bridge's error message.

Settings persist under SillyTavern's `extensionSettings.nat20`:

```json
{
    "bridgeUrl": "http://127.0.0.1:8020",
    "roster": {
        "<character name>": {
            "name": "...",
            "entity_id": "...",
            "build": {},
            "spells_known": [],
            "hp_current": 0
        }
    }
}
```

## Manual smoke test

_(Filled in with the Task 14 Step 4 script — run this after installing the
extension and starting the bridge to confirm the end-to-end path works.)_

1. Start `nat20-bridge`.
2. Load SillyTavern, open the Nat20 extension panel, click **Test
   connection** — expect a green `bridge … · engine … · data …` status.
3. _(more steps land with Task 14)_

## License

AGPL-3.0-or-later — see [LICENSE](./LICENSE).
