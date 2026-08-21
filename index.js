// Nat20 Rules Engine — SillyTavern UI extension.
//
// Talks to a localhost FastAPI sidecar ("nat20-bridge", default
// http://127.0.0.1:8020) that wraps the nat20 rules engine. This file is the
// only place that touches SillyTavern chat internals (see `postToChat`);
// later tasks (slash commands, popups, etc.) should call the exports below
// rather than reaching into `getCtx()` themselves.

const MODULE = 'nat20';
const EXTENSION_ID = 'SillyTavern-nat20';
const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:8020', roster: {} };

// The bridge combat_id of the in-progress fight, if any — module-level
// because it outlives any single slash-command invocation (turn commands
// need it) but doesn't belong in persisted settings (a combat doesn't
// survive a page reload the way the roster does).
let activeCombatId = null;

/**
 * @returns {ReturnType<typeof SillyTavern.getContext>}
 */
function getCtx() {
    return SillyTavern.getContext();
}

/**
 * Returns the persisted nat20 settings object, seeded with defaults on
 * first access. Mutating the returned object and calling `saveSettings()`
 * is how callers persist changes (matches ST's extensionSettings idiom).
 * @returns {{ bridgeUrl: string, roster: Record<string, object> }}
 */
function getSettings() {
    const { extensionSettings } = getCtx();
    extensionSettings[MODULE] = { ...DEFAULTS, ...(extensionSettings[MODULE] ?? {}) };
    return extensionSettings[MODULE];
}

function saveSettings() {
    getCtx().saveSettingsDebounced();
}

/**
 * Calls the nat20-bridge REST API.
 * @param {string} path Path under /v1, e.g. "/v1/health".
 * @param {{method?: string, body?: object}} [options]
 * @returns {Promise<object>} Parsed JSON body on 2xx.
 * @throws {Error} With the bridge's `detail` message (or a network-error
 *   message) on failure.
 */
async function bridgeFetch(path, { method = 'GET', body } = {}) {
    const url = getSettings().bridgeUrl.replace(/\/$/, '') + path;
    let resp;
    try {
        resp = await fetch(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw new Error(`nat20-bridge unreachable at ${url} — is \`nat20-bridge\` running?`);
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(data.detail ?? `bridge error ${resp.status}`);
    }
    return data;
}

/**
 * Inserts a narrator-style message into the current chat so the LLM
 * narrates around it. This is the single function in the extension that
 * touches SillyTavern chat internals (ctx.chat / addOneMessage / saveChat) —
 * keep it that way so future ST message-shape drift only needs a fix here.
 * @param {string} text
 */
async function postToChat(text) {
    const ctx = getCtx();
    const message = {
        name: 'Nat20',
        is_user: false,
        is_system: false,
        send_date: Date.now(),
        mes: text,
        extra: { isSmallSys: false, api: 'nat20' },
    };

    // ST's own callers push to `chat` before calling addOneMessage (see
    // public/script.js `addOneMessage`, which reads `chat.indexOf(mes)` to
    // find the message it just rendered), so mirror that order here.
    if (Array.isArray(ctx.chat)) {
        ctx.chat.push(message);
    }

    if (typeof ctx.addOneMessage === 'function') {
        ctx.addOneMessage(message);
    } else if (typeof ctx.sendSystemMessage === 'function') {
        // Defensive fallback for older/unusual ST builds where
        // addOneMessage isn't exposed on the context.
        ctx.sendSystemMessage('generic', text);
    } else {
        console.warn(`[${MODULE}] no chat-insertion API available on context; message not displayed:`, text);
    }

    if (typeof ctx.saveChat === 'function') {
        await ctx.saveChat();
    }
}

function setStatus($el, ok, text) {
    $el.text(text)
        .toggleClass('nat20-status--ok', ok)
        .toggleClass('nat20-status--error', !ok);
}

async function onTestConnectionClick() {
    const $status = $('#nat20_status');
    setStatus($status, true, 'checking…');
    try {
        const health = await bridgeFetch('/v1/health');
        setStatus($status, true, `bridge ${health.bridge} · engine ${health.engine} · data ${health.data}`);
    } catch (err) {
        setStatus($status, false, err.message);
    }
}

async function onHomebrewImportClick() {
    const $status = $('#nat20_status');
    const category = $('#nat20_homebrew_category').val();
    const raw = $('#nat20_homebrew_json').val();
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        setStatus($status, false, 'Invalid JSON');
        return;
    }
    try {
        // POST /v1/homebrew/{category} with the raw entry JSON as the body;
        // category is one of items/monsters/spells/species/classes/
        // subclasses/backgrounds/feats/features. Success returns the entry's
        // slug; failure carries the server's `detail` message.
        const result = await bridgeFetch(`/v1/homebrew/${category}`, { method: 'POST', body: payload });
        setStatus($status, true, `Imported as "${result.slug}".`);
    } catch (err) {
        setStatus($status, false, err.message);
    }
}

function onBridgeUrlInput() {
    const settings = getSettings();
    settings.bridgeUrl = $('#nat20_bridge_url').val();
    saveSettings();
}

// Maps a skill slug (as typed by the user, in any casing/spacing) to the
// ability score it's keyed off of per SRD 5.2 — needed because /v1/check
// always wants `ability`, even for skill checks.
const SKILL_ABILITY = {
    acrobatics: 'dex',
    animal_handling: 'wis',
    arcana: 'int',
    athletics: 'str',
    deception: 'cha',
    history: 'int',
    insight: 'wis',
    intimidation: 'cha',
    investigation: 'int',
    medicine: 'wis',
    nature: 'int',
    perception: 'wis',
    performance: 'cha',
    persuasion: 'cha',
    religion: 'int',
    sleight_of_hand: 'dex',
    stealth: 'dex',
    survival: 'wis',
};

// SRD categories tried in order when guessing what a /nat20-lookup query is.
const LOOKUP_CATEGORIES = [
    'spells', 'items', 'monsters', 'species', 'classes',
    'subclasses', 'backgrounds', 'feats', 'features',
];

// Canonical SRD slugs are hyphen-separated (cure-wounds, magic-missile) and
// the bridge does exact slug matches — used for /nat20-lookup.
function normalizeSlug(text) {
    return String(text).trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// SKILL_ABILITY keys are snake_case — used for /nat20-check's skill arg and
// /nat20-save's ability arg, kept distinct from SRD slug normalization above.
function normalizeSkillKey(text) {
    return String(text).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function capitalize(text) {
    const s = String(text).replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Finds a roster entry by PC name, case-insensitively, whether the roster
 * object is keyed by name or by some other id with a `.name` field.
 * @param {Record<string, object>} roster
 * @param {string} pcName
 * @returns {object|null}
 */
function findRosterEntry(roster, pcName) {
    if (roster[pcName]) return roster[pcName];
    const lower = pcName.toLowerCase();
    for (const key of Object.keys(roster)) {
        const entry = roster[key];
        if (key.toLowerCase() === lower) return entry;
        if (entry && typeof entry.name === 'string' && entry.name.toLowerCase() === lower) return entry;
    }
    return null;
}

/** Shared error funnel: bridge errors land in chat instead of the console. */
async function run(fn) {
    try {
        return await fn();
    } catch (e) {
        await postToChat(`⚠️ nat20: ${e.message}`);
        return null;
    }
}

/**
 * Builds and submits a /v1/check request (skill check or saving throw) for
 * a named roster PC, then narrates the result.
 * @param {'skill'|'saving_throw'} kind
 * @param {Record<string, string|number|undefined>} named `/nat20-check`/`/nat20-save` named args (pc, dc).
 * @param {string} arg The skill (for `skill`) or ability (for `saving_throw`).
 */
async function checkCommand(kind, named, arg) {
    const pcName = named?.pc;
    if (!pcName) {
        await postToChat('⚠️ nat20: specify pc=<name>, e.g. /nat20-check stealth pc=Elara dc=15');
        return '';
    }

    const roster = getSettings().roster ?? {};
    const entry = findRosterEntry(roster, String(pcName));
    if (!entry) {
        await postToChat(`⚠️ nat20: no roster PC named "${pcName}" — add one with /nat20-pc`);
        return '';
    }

    const build = entry.build ?? {};
    const abilityScores = build.ability_scores ?? {};
    const level = Number(build.level) || 1;
    const proficiencyBonus = 2 + Math.floor((level - 1) / 4);
    const proficientSkills = entry.proficient_skills ?? [];
    const proficientSaves = entry.proficient_saves ?? [];

    const body = {
        kind,
        ability_scores: abilityScores,
        proficiency_bonus: proficiencyBonus,
        proficient_skills: proficientSkills,
        proficient_saves: proficientSaves,
    };

    let label;
    if (kind === 'skill') {
        const skill = normalizeSkillKey(arg);
        body.skill = skill;
        body.ability = SKILL_ABILITY[skill] ?? 'str';
        label = `${capitalize(skill)} check`;
    } else {
        body.ability = normalizeSkillKey(arg);
        label = `${capitalize(arg)} save`;
    }

    if (named.dc !== undefined && named.dc !== null && named.dc !== '') {
        body.dc = Number(named.dc);
    }

    const result = await run(() => bridgeFetch('/v1/check', { method: 'POST', body }));
    if (!result) return '';

    let msg = `📋 ${entry.name} ${label}`;
    if (body.dc !== undefined) msg += ` vs DC ${body.dc}`;
    msg += `: **${result.roll_total}**`;
    if (result.success === true) msg += ' — success';
    else if (result.success === false) msg += ' — failure';
    await postToChat(msg);
    return String(result.roll_total);
}

/**
 * Looks up an SRD entry by name, guessing its category (spells, items,
 * monsters, ...) by trying each in turn, and posts a trimmed summary.
 * @param {string} query
 */
async function lookupCommand(query) {
    const slug = normalizeSlug(query);
    if (!slug) {
        await postToChat('⚠️ nat20: /nat20-lookup needs a name, e.g. /nat20-lookup fireball');
        return '';
    }

    for (const category of LOOKUP_CATEGORIES) {
        let entry;
        try {
            entry = await bridgeFetch(`/v1/srd/${category}/${slug}`);
        } catch {
            continue; // not in this category (404) or bridge hiccup — keep guessing
        }
        const description = typeof entry.description === 'string' ? entry.description : '';
        const summary = description.length > 300 ? `${description.slice(0, 300)}…` : description;
        await postToChat(`📖 **${entry.name}** (${category})${summary ? `\n${summary}` : ''}`);
        return entry.name;
    }

    await postToChat(`⚠️ nat20: no SRD entry found for "${query}"`);
    return '';
}

// Splits a comma-separated named-arg value ("fire-bolt, magic-missile") into
// a trimmed, empty-filtered list — used for /nat20-pc's spells=/equipment=.
function parseCommaList(text) {
    if (text === undefined || text === null || text === '') return [];
    return String(text).split(',').map((s) => s.trim()).filter(Boolean);
}

// Builds the {str,dex,con,int,wis,cha} ability_scores object /v1/party/validate
// expects from /nat20-pc's named args. A named arg that's actually present
// overrides; anything omitted falls back to `existing` (an in-progress
// update's current scores) and finally to the SRD default of 10 — this is
// what lets `/nat20-pc name=elara level=4` update just the level without
// resetting every other ability score to 10.
function abilityScoresFromNamed(named, existing = {}) {
    const pick = (key) => {
        const value = named?.[key];
        if (value === undefined || value === null || value === '') {
            return existing[key] !== undefined ? existing[key] : 10;
        }
        return Number(value);
    };
    return {
        str: pick('str'), dex: pick('dex'), con: pick('con'),
        int: pick('int'), wis: pick('wis'), cha: pick('cha'),
    };
}

/**
 * Shared /v1/party/validate → roster-store path used by /nat20-pc and
 * /nat20-pc-import. On success, stores the validate request body plus the
 * bits the bridge computed (entity_id, hp_max, current summary), persists,
 * and narrates the one-line summary.
 * @param {object} requestBody `{name, build, spells_known?, hp_current?, entity_id?}`.
 * @param {object} [opts]
 * @param {string} [opts.storeKey] Existing roster key to overwrite in place
 *   (case-insensitive re-run of `/nat20-pc` on an already-known PC), instead
 *   of defaulting to `requestBody.name` — avoids creating a second,
 *   differently-cased roster slot for the same character.
 * @param {object} [opts.existingEntry] The roster entry being updated, if
 *   any — its `hp_current`/`dice_remaining` are preserved (hp_current capped
 *   to the possibly-new hp_max) rather than reset by a partial update.
 * @returns {Promise<object|null>} The stored roster entry, or `null` on error
 *   (the `run()` funnel has already posted the bridge's error to chat).
 */
async function validateAndStore(requestBody, { storeKey, existingEntry } = {}) {
    const result = await run(() => bridgeFetch('/v1/party/validate', { method: 'POST', body: requestBody }));
    if (!result) return null;

    const settings = getSettings();
    const level = Number(requestBody.build?.level) || 1;
    const hpMax = result.member.hp_max;
    const hpCurrent = requestBody.hp_current !== undefined
        ? (result.member.hp_current ?? hpMax)
        : existingEntry
            ? Math.min(existingEntry.hp_current ?? hpMax, hpMax)
            : (result.member.hp_current ?? hpMax);

    const entry = {
        ...requestBody,
        entity_id: result.member.entity_id,
        hp_max: hpMax,
        hp_current: hpCurrent,
        dice_remaining: existingEntry?.dice_remaining ?? level,
        summary: result.summary,
    };
    settings.roster[storeKey ?? requestBody.name] = entry;
    saveSettings();
    await postToChat(`✅ ${result.summary}`);
    return entry;
}

// GET /v1/srd/classes/{slug} → hit_die ("d10") → 10, memoized per class slug
// for the lifetime of the page (rest commands need it every call).
const hitDieCache = new Map();

async function getHitDieSize(classSlug) {
    if (hitDieCache.has(classSlug)) return hitDieCache.get(classSlug);
    const entry = await bridgeFetch(`/v1/srd/classes/${classSlug}`);
    const match = /^d(\d+)$/.exec(String(entry.hit_die ?? '').trim());
    const size = match ? Number(match[1]) : 8;
    hitDieCache.set(classSlug, size);
    return size;
}

/**
 * Projects a roster entry down to the exact shape /v1/combat expects for a
 * party member — the roster entry itself carries extra bookkeeping fields
 * (hp_max, dice_remaining, summary) that PartyValidateRequest doesn't
 * declare. The bridge doesn't forbid extra fields (no `extra="forbid"`), so
 * sending them wouldn't error, but shipping only the fields the combat-start
 * payload actually documents is deliberate hygiene — an explicit allow-list,
 * never a spread.
 * @param {object} entry
 */
function projectPartyMember(entry) {
    return {
        name: entry.name,
        entity_id: entry.entity_id,
        build: entry.build,
        spells_known: entry.spells_known ?? [],
        hp_current: entry.hp_current,
    };
}

/**
 * Posts a combat envelope's narration block to chat and, if the fight just
 * ended, follows up with the standard "combat over" line and clears
 * `activeCombatId` so subsequent turn commands correctly report no active
 * combat.
 * @param {{narration?: string, over?: boolean}} result
 */
async function postCombatResult(result) {
    if (result.narration) await postToChat(result.narration);
    if (result.over) {
        await postToChat('⚔️ Combat over.');
        activeCombatId = null;
    }
}

/**
 * Resolves a user-typed target reference against a combat view's `order`
 * list: an exact `entity_id` match wins outright, otherwise falls back to a
 * case-insensitive prefix match on combatant name (so "goblin" can hit
 * "Goblin Warrior 1" without the caller knowing the synthesized entity id).
 * @param {Array<{entity_id: string, name: string}>} order
 * @param {string} targetText
 * @returns {{entityId: string}|{error: string}}
 */
function resolveTarget(order, targetText) {
    const text = String(targetText ?? '').trim();
    if (!text) return { error: 'no target specified' };

    const exact = order.find((o) => o.entity_id === text);
    if (exact) return { entityId: exact.entity_id };

    const lower = text.toLowerCase();
    const matches = order.filter(
        (o) => typeof o.name === 'string' && o.name.toLowerCase().startsWith(lower),
    );
    if (matches.length === 1) return { entityId: matches[0].entity_id };
    if (matches.length === 0) return { error: `no combatant matching "${text}"` };
    return {
        error: `ambiguous target "${text}" — matches: ${matches.map((m) => m.name).join(', ')}`,
    };
}

// GET /v1/combat/{id} returns `current_actor` as the composite
// "<entity_id> (<Name>)" string (routes_combat.py), not a bare entity_id —
// this pulls the id back out so actor-defaulting and the status marker can
// compare it against roster/order entity_ids.
function currentActorId(view) {
    return String(view?.current_actor ?? '').split(' ')[0];
}

// Splits a turn-command's raw unnamed-arg text into a leading slug token
// (spell/item/feature id) and whatever's left as the target reference — used
// by /nat20-cast, /nat20-use-item, and /nat20-feature, whose target (unlike
// /nat20-attack's) can be omitted entirely for self-targeted uses.
function parseSlugAndTarget(raw) {
    const text = String(raw ?? '').trim();
    const match = /^(\S+)\s*(.*)$/.exec(text);
    if (!match) return { slug: '', target: '' };
    return { slug: match[1], target: match[2].trim() };
}

/**
 * Shared submit path for the four in-combat turn commands (attack, cast,
 * use-item, feature): resolves the acting PC (explicit `pc=` or, failing
 * that, the current actor if it's a roster PC), resolves an optional target
 * reference against the live combat view, and posts `/v1/combat/{id}/intent`.
 * @param {string} intentType e.g. 'attack', 'cast_spell', 'use_item', 'use_feature'.
 * @param {string} idField The intent body field the slug rides in, e.g. 'weapon_id'.
 * @param {string} slugValue The raw (un-normalized) slug typed by the user.
 * @param {Record<string, string|undefined>} named Command named args (`pc=`, etc.).
 * @param {string} targetText Raw target text, or '' for no target.
 * @returns {Promise<string>} The resolved target/actor entity_id, or '' on error.
 */
async function submitIntent(intentType, idField, slugValue, named, targetText) {
    if (!activeCombatId) {
        await postToChat('⚠️ nat20: no active combat — start one with /nat20-fight');
        return '';
    }

    const view = await run(() => bridgeFetch(`/v1/combat/${activeCombatId}`));
    if (!view) return '';

    const roster = getSettings().roster ?? {};
    let actorId;
    if (named?.pc) {
        const entry = findRosterEntry(roster, String(named.pc));
        if (!entry?.entity_id) {
            await postToChat(`⚠️ nat20: no roster PC named "${named.pc}" — add one with /nat20-pc`);
            return '';
        }
        actorId = entry.entity_id;
    } else {
        const currentId = currentActorId(view);
        const isRosterPc = Object.values(roster).some((e) => e.entity_id === currentId);
        if (!isRosterPc) {
            await postToChat("⚠️ nat20: not a PC's turn — specify pc=<name>");
            return '';
        }
        actorId = currentId;
    }

    const body = { actor_id: actorId, intent_type: intentType };
    if (idField && slugValue) body[idField] = normalizeSlug(slugValue);

    if (targetText) {
        const resolved = resolveTarget(view.order ?? [], targetText);
        if (resolved.error) {
            await postToChat(`⚠️ nat20: ${resolved.error}`);
            return '';
        }
        body.target_id = resolved.entityId;
    }

    const result = await run(() => bridgeFetch(`/v1/combat/${activeCombatId}/intent`, { method: 'POST', body }));
    if (!result) return '';
    await postCombatResult(result);
    return body.target_id ?? actorId;
}

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument,
        ARGUMENT_TYPE } = getCtx();

    const cmd = (name, helpString, namedArgs, callback) =>
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name, helpString, namedArgumentList: namedArgs, callback,
        }));

    cmd('nat20-roll', 'Roll dice, e.g. /nat20-roll 2d6+3', [],
        async (_named, dice) => {
            const r = await run(() => bridgeFetch('/v1/roll',
                { method: 'POST', body: { dice: String(dice) } }));
            if (r) await postToChat(`🎲 ${dice} → **${r.total}**`);
            return r ? String(r.total) : '';
        });

    cmd('nat20-check',
        'Skill check for a roster PC: /nat20-check stealth pc=Elara dc=15',
        [
            SlashCommandNamedArgument.fromProps({ name: 'pc', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'dc', typeList: ARGUMENT_TYPE.NUMBER }),
        ],
        async (named, skill) => checkCommand('skill', named, String(skill)));

    cmd('nat20-save',
        'Saving throw for a roster PC: /nat20-save dex pc=Elara dc=15',
        [
            SlashCommandNamedArgument.fromProps({ name: 'pc', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'dc', typeList: ARGUMENT_TYPE.NUMBER }),
        ],
        async (named, ability) => checkCommand('saving_throw', named, String(ability)));

    cmd('nat20-lookup',
        'Look up an SRD entry by name, e.g. /nat20-lookup fireball',
        [],
        async (_named, query) => lookupCommand(String(query)));

    cmd('nat20-pc',
        'Create/update a roster PC: /nat20-pc name=Elara class=wizard species=elf-high level=3 ' +
        'str=8 dex=14 con=13 int=15 wis=12 cha=10 spells=fire-bolt,magic-missile equipment=quarterstaff',
        [
            SlashCommandNamedArgument.fromProps({ name: 'name', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'class', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'species', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'subclass', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'level', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandNamedArgument.fromProps({ name: 'str', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandNamedArgument.fromProps({ name: 'dex', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandNamedArgument.fromProps({ name: 'con', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandNamedArgument.fromProps({ name: 'int', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandNamedArgument.fromProps({ name: 'wis', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandNamedArgument.fromProps({ name: 'cha', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandNamedArgument.fromProps({ name: 'spells', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'equipment', typeList: ARGUMENT_TYPE.STRING }),
        ],
        async (named) => {
            if (!named?.name) {
                await postToChat('⚠️ nat20: /nat20-pc needs name=, class=, species=, and level=, e.g. ' +
                    '/nat20-pc name=Elara class=wizard species=elf-high level=3 str=8 dex=14 con=13 int=15 wis=12 cha=10');
                return '';
            }

            // Case-insensitive: re-running /nat20-pc on an already-known PC
            // (any casing) updates that same roster slot instead of creating
            // a second one (findRosterEntry is what every other command uses
            // to look PCs up, so staying consistent with it here matters).
            const roster = getSettings().roster ?? {};
            const existing = findRosterEntry(roster, String(named.name));
            const storeKey = existing ? Object.keys(roster).find((k) => roster[k] === existing) : undefined;
            const existingBuild = existing?.build ?? {};

            if (!existing && (!named.class || !named.species || !named.level)) {
                await postToChat('⚠️ nat20: new PCs need class=, species=, and level=, e.g. ' +
                    '/nat20-pc name=Elara class=wizard species=elf-high level=3 str=8 dex=14 con=13 int=15 wis=12 cha=10');
                return '';
            }

            // Merge onto the existing build so an update that only passes
            // e.g. level= doesn't revert every omitted field (ability
            // scores back to 10, equipment/spells to empty) — new PCs have
            // no existingBuild, so this is a no-op for them.
            const requestBody = {
                name: existing ? existing.name : String(named.name),
                build: {
                    species_slug: named.species ? normalizeSlug(named.species) : existingBuild.species_slug,
                    class_slug: named.class ? normalizeSlug(named.class) : existingBuild.class_slug,
                    level: (named.level !== undefined && named.level !== null && named.level !== '')
                        ? Number(named.level) : existingBuild.level,
                    ability_scores: abilityScoresFromNamed(named, existingBuild.ability_scores),
                    equipment: (named.equipment !== undefined && named.equipment !== null && named.equipment !== '')
                        ? parseCommaList(named.equipment).map(normalizeSlug)
                        : (existingBuild.equipment ?? []),
                },
            };
            const subclassSlug = named.subclass ? normalizeSlug(named.subclass) : existingBuild.subclass_slug;
            if (subclassSlug) requestBody.build.subclass_slug = subclassSlug;

            const spells = (named.spells !== undefined && named.spells !== null && named.spells !== '')
                ? parseCommaList(named.spells).map(normalizeSlug)
                : (existing?.spells_known ?? []);
            if (spells.length) requestBody.spells_known = spells;

            if (existing?.entity_id) requestBody.entity_id = existing.entity_id;

            const entry = await validateAndStore(requestBody, { storeKey, existingEntry: existing });
            return entry?.entity_id ?? '';
        });

    cmd('nat20-pc-import',
        'Import a roster PC from raw JSON, e.g. /nat20-pc-import {"name":"Elara","build":{"species_slug":"elf-high",' +
        '"class_slug":"wizard","level":3,"ability_scores":{"str":8,"dex":14,"con":13,"int":15,"wis":12,"cha":10}}}',
        [],
        async (_named, raw) => {
            let requestBody;
            try {
                requestBody = JSON.parse(String(raw));
            } catch {
                await postToChat('⚠️ nat20: /nat20-pc-import needs valid JSON, e.g. /nat20-pc-import ' +
                    '{"name":"Elara","build":{"species_slug":"elf-high","class_slug":"wizard","level":3,' +
                    '"ability_scores":{"str":8,"dex":14,"con":13,"int":15,"wis":12,"cha":10}}}');
                return '';
            }
            if (!requestBody?.name) {
                await postToChat('⚠️ nat20: imported JSON needs a "name" field');
                return '';
            }

            const entry = await validateAndStore(requestBody);
            return entry?.entity_id ?? '';
        });

    cmd('nat20-party', 'List roster PCs', [],
        async () => {
            const roster = getSettings().roster ?? {};
            const names = Object.keys(roster);
            if (!names.length) {
                await postToChat('nat20: roster is empty — add a PC with /nat20-pc');
                return '';
            }

            const lines = names.map((key) => {
                const entry = roster[key];
                if (entry.summary) {
                    return `- ${entry.summary}`;
                }
                const classLevel = entry.build ? `${entry.build.class_slug} ${entry.build.level}` : '';
                const hp = `HP ${entry.hp_current}/${entry.hp_max}`;
                return `- **${entry.name}** (${classLevel}) — ${hp}`;
            });
            await postToChat(`🎭 **Party**\n${lines.join('\n')}`);
            return String(names.length);
        });

    cmd('nat20-pc-remove', 'Remove a PC from the roster: /nat20-pc-remove Elara', [],
        async (_named, pcName) => {
            const roster = getSettings().roster ?? {};
            const entry = findRosterEntry(roster, String(pcName));
            if (!entry) {
                await postToChat(`⚠️ nat20: no roster PC named "${pcName}"`);
                return '';
            }

            const key = Object.keys(roster).find((k) => roster[k] === entry);
            delete roster[key];
            saveSettings();
            await postToChat(`🗑️ removed ${entry.name} from the roster`);
            return entry.name;
        });

    cmd('nat20-equip',
        'Add equipment to a roster PC and re-validate: /nat20-equip Elara hb-frost-brand',
        [],
        async (_named, args) => {
            const [pcName, slug] = String(args).trim().split(/\s+/).filter(Boolean);
            if (!pcName || !slug) {
                await postToChat('⚠️ nat20: /nat20-equip needs a PC name and an item slug, ' +
                    'e.g. /nat20-equip Elara hb-frost-brand');
                return '';
            }

            const roster = getSettings().roster ?? {};
            const entry = findRosterEntry(roster, pcName);
            if (!entry) {
                await postToChat(`⚠️ nat20: no roster PC named "${pcName}" — add one with /nat20-pc`);
                return '';
            }

            entry.build = entry.build ?? {};
            entry.build.equipment = Array.isArray(entry.build.equipment) ? entry.build.equipment : [];
            entry.build.equipment.push(normalizeSlug(slug));

            const requestBody = {
                name: entry.name,
                entity_id: entry.entity_id,
                build: entry.build,
                spells_known: entry.spells_known,
                hp_current: entry.hp_current,
            };

            // Mutate-then-validate, with a rollback on rejection below: relies on
            // bridgeFetch's JSON.stringify(body) happening synchronously before
            // its `await fetch(...)`, so `requestBody` (built from `entry.build`,
            // already carrying the pushed slug) is serialized before any later
            // mutation could touch it. Correct today, but fragile — if bridgeFetch
            // ever stringifies lazily (e.g. after an await), this needs revisiting.
            const result = await run(() => bridgeFetch('/v1/party/validate', { method: 'POST', body: requestBody }));
            if (!result) {
                entry.build.equipment.pop(); // validate rejected it — roll back the append
                return '';
            }

            entry.entity_id = result.member.entity_id;
            entry.hp_max = result.member.hp_max;
            entry.hp_current = result.member.hp_current ?? result.member.hp_max;
            entry.summary = result.summary;
            saveSettings();
            await postToChat(`✅ ${result.summary}`);
            return entry.entity_id ?? '';
        });

    cmd('nat20-rest',
        'Short/long rest for a roster PC: /nat20-rest short pc=Elara dice=2  |  /nat20-rest long pc=Elara',
        [
            SlashCommandNamedArgument.fromProps({ name: 'pc', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'dice', typeList: ARGUMENT_TYPE.NUMBER }),
        ],
        async (named, kind) => {
            const restKind = String(kind).trim().toLowerCase();
            if (restKind !== 'short' && restKind !== 'long') {
                await postToChat('⚠️ nat20: /nat20-rest needs "short" or "long", e.g. /nat20-rest short pc=Elara dice=2');
                return '';
            }

            const pcName = named?.pc;
            if (!pcName) {
                await postToChat('⚠️ nat20: specify pc=<name>, e.g. /nat20-rest short pc=Elara dice=2');
                return '';
            }

            const roster = getSettings().roster ?? {};
            const entry = findRosterEntry(roster, String(pcName));
            if (!entry) {
                await postToChat(`⚠️ nat20: no roster PC named "${pcName}" — add one with /nat20-pc`);
                return '';
            }

            let diceToSpend;
            if (restKind === 'short') {
                diceToSpend = Number(named.dice);
                if (!diceToSpend) {
                    await postToChat('⚠️ nat20: /nat20-rest short needs dice=<n>, e.g. /nat20-rest short pc=Elara dice=2');
                    return '';
                }
            }

            const build = entry.build ?? {};
            const level = Number(build.level) || 1;
            const diceRemaining = entry.dice_remaining ?? level;
            const conModifier = Math.floor((Number(build.ability_scores?.con ?? 10) - 10) / 2);

            const result = await run(async () => {
                const hitDieSize = await getHitDieSize(String(build.class_slug ?? ''));
                const body = {
                    hit_die_size: hitDieSize,
                    dice_remaining: diceRemaining,
                    dice_total: level,
                    hp_current: entry.hp_current,
                    hp_max: entry.hp_max,
                };
                if (restKind === 'short') {
                    body.dice_to_spend = diceToSpend;
                    body.con_modifier = conModifier;
                    return bridgeFetch('/v1/rest/short', { method: 'POST', body });
                }
                return bridgeFetch('/v1/rest/long', { method: 'POST', body });
            });
            if (!result) return '';

            entry.hp_current = result.hp_current;
            entry.dice_remaining = result.dice_remaining;
            saveSettings();
            await postToChat(`💤 ${entry.name} takes a ${restKind} rest — heals ${result.healed}, ` +
                `HP ${entry.hp_current}/${entry.hp_max}, hit dice remaining ${entry.dice_remaining}`);
            return String(entry.hp_current);
        });

    cmd('nat20-fight',
        'Start a combat: /nat20-fight goblin-warrior goblin-warrior party=Elara,Brom (party defaults to the whole roster)',
        [
            SlashCommandNamedArgument.fromProps({ name: 'party', typeList: ARGUMENT_TYPE.STRING }),
        ],
        async (named, args) => {
            const monsters = String(args ?? '').trim().split(/\s+/).filter(Boolean).map(normalizeSlug);
            if (!monsters.length) {
                await postToChat('⚠️ nat20: /nat20-fight needs at least one monster slug, e.g. /nat20-fight goblin-warrior');
                return '';
            }

            const roster = getSettings().roster ?? {};
            let entries;
            if (named?.party) {
                entries = [];
                for (const name of parseCommaList(named.party)) {
                    const entry = findRosterEntry(roster, name);
                    if (!entry) {
                        await postToChat(`⚠️ nat20: no roster PC named "${name}"`);
                        return '';
                    }
                    entries.push(entry);
                }
            } else {
                entries = Object.values(roster);
            }

            if (!entries.length) {
                await postToChat('⚠️ nat20: No party — create one with /nat20-pc first');
                return '';
            }

            const body = {
                party: entries.map(projectPartyMember),
                monsters,
                seed: Math.floor(Math.random() * 2 ** 31),
            };

            const result = await run(() => bridgeFetch('/v1/combat', { method: 'POST', body }));
            if (!result) return '';

            activeCombatId = result.combat_id;
            await postCombatResult(result);
            return activeCombatId ?? '';
        });

    cmd('nat20-attack',
        'Attack in combat: /nat20-attack <target> weapon=<slug> pc=<name>',
        [
            SlashCommandNamedArgument.fromProps({ name: 'weapon', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'pc', typeList: ARGUMENT_TYPE.STRING }),
        ],
        async (named, args) => {
            const target = String(args ?? '').trim();
            if (!target) {
                await postToChat('⚠️ nat20: /nat20-attack needs a target, e.g. /nat20-attack goblin weapon=longsword');
                return '';
            }
            return submitIntent('attack', 'weapon_id', named?.weapon, named, target);
        });

    cmd('nat20-cast',
        'Cast a spell in combat: /nat20-cast <spell-slug> <target> pc=<name>',
        [
            SlashCommandNamedArgument.fromProps({ name: 'pc', typeList: ARGUMENT_TYPE.STRING }),
        ],
        async (named, args) => {
            const { slug, target } = parseSlugAndTarget(args);
            if (!slug) {
                await postToChat('⚠️ nat20: /nat20-cast needs a spell slug, e.g. /nat20-cast fire-bolt goblin');
                return '';
            }
            return submitIntent('cast_spell', 'spell_id', slug, named, target);
        });

    cmd('nat20-use-item',
        'Use an item in combat: /nat20-use-item <item-slug> <target> pc=<name>',
        [
            SlashCommandNamedArgument.fromProps({ name: 'pc', typeList: ARGUMENT_TYPE.STRING }),
        ],
        async (named, args) => {
            const { slug, target } = parseSlugAndTarget(args);
            if (!slug) {
                await postToChat('⚠️ nat20: /nat20-use-item needs an item slug, e.g. /nat20-use-item potion-of-healing');
                return '';
            }
            return submitIntent('use_item', 'item_id', slug, named, target);
        });

    cmd('nat20-feature',
        'Use a class feature in combat: /nat20-feature <feature-slug> <target> pc=<name>',
        [
            SlashCommandNamedArgument.fromProps({ name: 'pc', typeList: ARGUMENT_TYPE.STRING }),
        ],
        async (named, args) => {
            const { slug, target } = parseSlugAndTarget(args);
            if (!slug) {
                await postToChat('⚠️ nat20: /nat20-feature needs a feature slug, e.g. /nat20-feature second-wind');
                return '';
            }
            return submitIntent('use_feature', 'feature_id', slug, named, target);
        });

    cmd('nat20-next', 'Advance the current monster\'s turn', [],
        async () => {
            if (!activeCombatId) {
                await postToChat('⚠️ nat20: no active combat — start one with /nat20-fight');
                return '';
            }
            const result = await run(() => bridgeFetch(`/v1/combat/${activeCombatId}/advance-monster`, { method: 'POST', body: {} }));
            if (!result) return '';
            await postCombatResult(result);
            return activeCombatId ?? '';
        });

    cmd('nat20-status', 'Show the current combat round, turn order, HP, and conditions', [],
        async () => {
            if (!activeCombatId) {
                await postToChat('⚠️ nat20: no active combat — start one with /nat20-fight');
                return '';
            }
            const view = await run(() => bridgeFetch(`/v1/combat/${activeCombatId}`));
            if (!view) return '';

            const rows = (view.order ?? []).map((o) => {
                const marker = o.entity_id === currentActorId(view) ? '➤' : '';
                const conditions = [o.dead ? 'dead' : null, ...(o.conditions ?? [])].filter(Boolean).join(', ');
                return `| ${marker} | ${o.name} | ${o.hp}/${o.max_hp} | ${conditions} |`;
            });
            const table = [
                '| | Name | HP | Conditions |',
                '| --- | --- | --- | --- |',
                ...rows,
            ].join('\n');

            await postToChat(`📊 **Round ${view.round_number}**\n${table}`);
            return String(view.round_number);
        });

    cmd('nat20-end', 'End the current combat and show the outcome', [],
        async () => {
            if (!activeCombatId) {
                await postToChat('⚠️ nat20: no active combat — start one with /nat20-fight');
                return '';
            }
            const result = await run(() => bridgeFetch(`/v1/combat/${activeCombatId}/end`, { method: 'POST', body: {} }));
            if (!result) return '';
            activeCombatId = null;

            const outcome = result.outcome ?? {};
            let msg = `🏁 Combat ended — ${outcome.ended_reason ?? 'unknown'}`;
            if (outcome.xp !== undefined) msg += ` — XP: ${outcome.xp}`;
            if (outcome.loot) {
                msg += ` — Loot: ${Array.isArray(outcome.loot) ? outcome.loot.join(', ') : outcome.loot}`;
            }
            if (result.narration) msg += `\n${result.narration}`;
            await postToChat(msg);
            return outcome.ended_reason ?? '';
        });

    cmd('nat20-homebrew-import',
        'Import homebrew content: /nat20-homebrew-import {"name":"Frost Brand",...} category=items (default: items)',
        [
            SlashCommandNamedArgument.fromProps({ name: 'category', typeList: ARGUMENT_TYPE.STRING }),
        ],
        async (named, raw) => {
            let payload;
            try {
                payload = JSON.parse(String(raw));
            } catch {
                await postToChat('⚠️ nat20: /nat20-homebrew-import needs valid JSON, e.g. ' +
                    '/nat20-homebrew-import {"name":"Frost Brand"} category=items');
                return '';
            }
            const category = named?.category ? String(named.category).trim() : 'items';
            const result = await run(() => bridgeFetch(`/v1/homebrew/${category}`, { method: 'POST', body: payload }));
            if (!result) return '';
            await postToChat(`✅ Imported as "${result.slug}".`);
            return result.slug ?? '';
        });

    cmd('nat20-forge-item',
        'Forge a magic item: /nat20-forge-item name="Frost Brand" base=longsword damage=1d6:cold bonus=1',
        [
            SlashCommandNamedArgument.fromProps({ name: 'name', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'base', typeList: ARGUMENT_TYPE.STRING }),
            SlashCommandNamedArgument.fromProps({ name: 'bonus', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandNamedArgument.fromProps({ name: 'damage', typeList: ARGUMENT_TYPE.STRING }),
        ],
        async (named) => {
            if (!named?.name || !named?.base) {
                await postToChat('⚠️ nat20: /nat20-forge-item needs name= and base=, e.g. ' +
                    '/nat20-forge-item name="Frost Brand" base=longsword damage=1d6:cold bonus=1');
                return '';
            }

            const body = { name: String(named.name), base: normalizeSlug(named.base) };
            if (named.bonus !== undefined && named.bonus !== null && named.bonus !== '') {
                body.bonus = Number(named.bonus);
            }
            if (named.damage) body.extra_damage = String(named.damage);

            const result = await run(() => bridgeFetch('/v1/forge/item', { method: 'POST', body }));
            if (!result) return '';
            await postToChat(`🔨 ${result.summary}`);
            return result.slug ?? '';
        });
}

jQuery(async () => {
    const settingsHtml = await getCtx().renderExtensionTemplateAsync(`third-party/${EXTENSION_ID}`, 'settings');
    $('#extensions_settings2').append(settingsHtml);

    const settings = getSettings();
    $('#nat20_bridge_url').val(settings.bridgeUrl);

    $('#nat20_bridge_url').on('input', onBridgeUrlInput);
    $('#nat20_test_connection').on('click', onTestConnectionClick);
    $('#nat20_homebrew_import').on('click', onHomebrewImportClick);

    registerCommands();
});

export { bridgeFetch, getSettings, postToChat };
