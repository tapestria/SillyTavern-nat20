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

   The extension needs `nat20-bridge` 0.7.0 or newer; it refuses to start a
   fight on an older one. If `uvx` has cached an older release, run
   `uvx nat20-bridge@latest`.

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

SillyTavern's STscript grammar requires all `name=value` arguments to appear
before any positional/unnamed arguments on the line, so always put `weapon=`,
`pc=`, `party=`, etc. first and the plain-text argument(s) last.

| Command | Description |
| --- | --- |
| `/nat20-roll <dice>` | Roll dice via the bridge, e.g. `/nat20-roll 2d6+3`. |
| `/nat20-check pc=<name> [dc=<n>] <skill>` | Skill check for a roster PC, e.g. `/nat20-check pc=Elara dc=15 stealth`. |
| `/nat20-save pc=<name> [dc=<n>] <ability>` | Saving throw for a roster PC, e.g. `/nat20-save pc=Elara dc=15 dex`. |
| `/nat20-lookup <name>` | Look up an SRD entry by name across spells/items/monsters/etc, e.g. `/nat20-lookup fireball`. |
| `/nat20-pc name=<n> class=<slug> species=<slug> [subclass=<slug>] level=<n> str= dex= con= int= wis= cha= [spells=<a,b>] [equipment=<a,b>]` | Create or update (case-insensitive, in place) a roster PC. |
| `/nat20-pc-import <json>` | Import a roster PC from raw `/v1/party/validate`-shaped JSON. |
| `/nat20-party` | List roster PCs with class/level/HP/summary. |
| `/nat20-pc-remove <name>` | Remove a PC from the roster. |
| `/nat20-equip <name> <item-slug>` | Add an item to a PC's equipment and re-validate, e.g. `/nat20-equip Elara hb-frost-brand`. |
| `/nat20-rest pc=<name> dice=<n> short` / `/nat20-rest pc=<name> long` | Short or long rest for a roster PC. |
| `/nat20-fight [party=<name,name,...>] <monster-slug>...` | Start a combat against the given monster slugs (each instantiated separately, so repeat a slug for multiple copies). `party=` defaults to the whole roster; errors if the roster is empty. Stores the returned `combat_id` for subsequent turn commands. |
| `/nat20-attack weapon=<slug> [pc=<name>] <target>` / `/nat20-attack action=<id> [pc=<summon>] <target>` | Submit an attack intent. `pc=` picks the actor explicitly: a party PC in the fight, or a creature one of them summoned (Summon Dragon's Draconic Spirit); otherwise the current actor, if it's one of those. A summon attacks with an action from its stat block (`action=rend`). `<target>` matches an `entity_id` exactly, then a whole combatant name, then a name prefix (names case-insensitive) (errors on no match or ambiguous matches). |
| `/nat20-cast [pc=<name>] [slot=<level>] <spell-slug> [<target>]` | Submit a cast-spell intent; `slot=` upcasts; target is optional for self-targeted spells. |
| `/nat20-use-item [pc=<name>] <item-slug> [<target>]` | Submit a use-item intent. |
| `/nat20-feature [pc=<name>] [activity=<id>] <feature-slug> [<target>]` | Submit a use-feature intent (class features); `activity=` picks one option of a multi-option feature such as Channel Divinity. |
| `/nat20-next` | Advance the current monster's turn. If the engine can't resolve the action the foe picked (a few stat blocks, listed in nat20's backlog), it says so: retry, or `/nat20-end`. |
| `/nat20-status` | Render a markdown table of the current round's turn order, HP, and conditions, with `➤` marking the current actor. |
| `/nat20-map` | Draw the battlefield: a token per combatant on the bridge's grid, plus blocked/difficult/cover terrain and wall segments. The current actor is ringed, dead combatants struck through, and a cell holding several combatants shows a count badge. |
| `/nat20-end` | End the active combat, post the outcome (`ended_reason`, XP, loot if present), and clear the stored combat id. |
| `/nat20-forge-item name="<name>" base=<slug> [bonus=<n>] [damage=<XdY:type>]` | Forge a magic item via `/v1/forge/item`, e.g. `/nat20-forge-item name="Frost Brand" base=longsword damage=1d6:cold bonus=1`. |
| `/nat20-homebrew-import <json> [category=<cat>]` | Import homebrew content via `/v1/homebrew/{category}` (default `items`); same endpoint the settings-panel importer uses. |

Every combat-turn command errors with "no active combat" if none is running
(start one with `/nat20-fight`). Only `/nat20-end` closes a fight: after each
turn the extension reads the combat view and, once every foe (or every party
member) is dead, posts a reminder to `/nat20-end`. Starting a new fight ends
the previous one, and if the bridge no longer knows the stored fight (it was
restarted, or the fight expired) the extension clears it. When the engine
refuses an intent partway through (the bridge's 422), the extension posts the
turn order so you can see what was already spent.

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

Run this after installing the extension and starting the bridge to confirm
the end-to-end path works. Each step's expected chat output is shown as a
loose shape — exact wording/rolls will vary.

1. Start `nat20-bridge`.
2. Load SillyTavern, open the Nat20 extension panel, click **Test
   connection**.
   - Expect: a green status line `bridge <ver> · engine <ver> · data <ver>`.
3. `/nat20-pc name=Elara class=wizard species=elf-high level=3 str=8 dex=14 con=13 int=15 wis=12 cha=10 spells=fire-bolt,magic-missile`
   - Expect: `✅ Elara — <class/level/HP summary>` in chat.
4. `/nat20-forge-item name="Frost Brand" base=quarterstaff damage=1d6:cold bonus=1`
   - Expect: `🔨 <forged-item summary>` in chat (a slug like `hb-frost-brand`).
5. `/nat20-equip Elara hb-frost-brand`
   - Expect: `✅ Elara — <summary>` (the bridge re-validated the build with
     the new item; the summary line itself doesn't list equipment).
6. `/nat20-fight goblin-warrior`
   - Expect: the fight's opening narration block posted to chat (round 1,
     initiative order established).
7. `/nat20-status`
   - Expect: a markdown table (`| | Name | HP | Conditions |`) with `➤`
     marking whoever's turn it is.
8. If it's Elara's turn: `/nat20-attack weapon=quarterstaff goblin` (or
   `/nat20-cast fire-bolt goblin`). If it's the goblin's turn: `/nat20-next`.
   - Expect: narration of the attack/spell/monster-turn's outcome; repeat
     this step (checking `/nat20-status` as needed) until one side is down.
   - Expect on the finishing turn: `⚔️ Every foe is down — /nat20-end to
     settle the fight.`
9. `/nat20-end`
   - Expect: `🏁 Combat ended — <victory/defeat_tpk/flee/forced>` with XP/loot
     if the bridge returned any.

## Known limitations

- **Skill/save proficiency for roster PCs isn't applied yet.** The
  extension doesn't send a PC's proficiencies to `/v1/check`, so ability
  checks and saving throws resolve as if the character were non-proficient,
  even for skills/saves their class or background grants proficiency in.
- Engine gaps (stat blocks it can't run yet, features that raise) are tracked
  in [nat20](https://github.com/tapestria/nat20)'s backlog.
- **Monster movement ignores occupancy, so `/nat20-map` can stack tokens.**
  PC moves honour occupied cells, but the engine's monster walk paths don't
  (a documented asymmetry upstream), so a monster may end its move inside
  another combatant's square. The map overlaps stacked tokens and shows a
  count badge rather than hiding any, but the topmost token still covers
  the others.

## Development

`grid.js` is pure (no SillyTavern globals, no network), so it is unit-tested
with Node's built-in runner — no dependencies to install:

```bash
npm test
```

## License

AGPL-3.0-or-later — see [LICENSE](./LICENSE).
