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
    const $status = $('#nat20_homebrew_status');
    const raw = $('#nat20_homebrew_json').val();
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        setStatus($status, false, 'Invalid JSON');
        return;
    }
    try {
        // Endpoint/shape finalized in a later task; this wires the button
        // through bridgeFetch so it's ready once that lands.
        await bridgeFetch('/v1/homebrew', { method: 'POST', body: payload });
        setStatus($status, true, 'Imported.');
    } catch (err) {
        setStatus($status, false, err.message);
    }
}

function onBridgeUrlInput() {
    const settings = getSettings();
    settings.bridgeUrl = $('#nat20_bridge_url').val();
    saveSettings();
}

jQuery(async () => {
    const settingsHtml = await getCtx().renderExtensionTemplateAsync(`third-party/${EXTENSION_ID}`, 'settings');
    $('#extensions_settings2').append(settingsHtml);

    const settings = getSettings();
    $('#nat20_bridge_url').val(settings.bridgeUrl);

    $('#nat20_bridge_url').on('input', onBridgeUrlInput);
    $('#nat20_test_connection').on('click', onTestConnectionClick);
    $('#nat20_homebrew_import').on('click', onHomebrewImportClick);
});

export { bridgeFetch, getSettings, postToChat };
