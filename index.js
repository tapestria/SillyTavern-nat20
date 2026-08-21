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

function normalizeSlug(text) {
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
        const skill = normalizeSlug(arg);
        body.skill = skill;
        body.ability = SKILL_ABILITY[skill] ?? 'str';
        label = `${capitalize(skill)} check`;
    } else {
        body.ability = normalizeSlug(arg);
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
