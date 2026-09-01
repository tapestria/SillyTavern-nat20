// Battlefield rendering for the nat20 grid.
//
// The bridge's GET /v1/combat/{cid} view carries a `zone` ("col,row") per
// combatant plus a `grid` block describing the battlefield it sits on. This
// module turns that pair into a drawable structure and then into HTML; it is
// pure (no SillyTavern globals, no fetch) so it can be tested standalone.
//
// Ported from the nat20 repo's apps/demo renderer (`nat20_demo/render.py`
// and `templates/_grid.html`), with one deliberate divergence: the demo maps
// each cell to at most one token ("last writer wins"), which silently hides
// combatants. The engine permits co-occupancy — `spatial.py::is_passable`
// checks bounds and impassability only, never occupancy — so cells here hold
// every token standing on them.

/** Cell id for a column/row pair — mirrors `dnd5e_engine.spatial.cell_id`. */
function cellId(col, row) {
    return `${col},${row}`;
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

/** The terrain class of a cell — blocked and difficult outrank cover. */
function cellKind(grid, cid) {
    if ((grid.blocked_cells ?? []).includes(cid)) return 'blocked';
    if ((grid.difficult_terrain_cells ?? []).includes(cid)) return 'difficult';
    const cover = (grid.cover_cells ?? {})[cid];
    return cover ? `cover_${cover}` : 'floor';
}

function token(row, currentActorId) {
    return {
        entityId: row.entity_id,
        name: row.name ?? row.entity_id,
        side: String(row.entity_id ?? '').startsWith('char:') ? 'pc' : 'foe',
        dead: Boolean(row.dead),
        current: row.entity_id === currentActorId,
    };
}

/**
 * The grid, its terrain, and every token standing on each cell.
 *
 * Combatants whose `zone` falls outside the reported grid are dropped rather
 * than forced into a cell: the bridge is the authority on both numbers, and
 * a mismatch between them is a bug to surface, not one to paper over.
 *
 * @param {object} view A bridge GET /v1/combat/{cid} payload.
 * @returns {{width: number, height: number, cells: object[], walls: object[]}}
 */
export function buildGrid(view) {
    const grid = view?.grid ?? { width: 0, height: 0 };
    const width = grid.width ?? 0;
    const height = grid.height ?? 0;
    const currentActorId = String(view?.current_actor ?? '').split(' ')[0];

    const stacks = new Map();
    for (const row of view?.order ?? []) {
        if (!row?.zone) continue;
        if (!stacks.has(row.zone)) stacks.set(row.zone, []);
        stacks.get(row.zone).push(token(row, currentActorId));
    }

    const cells = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const cid = cellId(col, row);
            cells.push({ cellId: cid, col, row, kind: cellKind(grid, cid), tokens: stacks.get(cid) ?? [] });
        }
    }

    return { width, height, cells, walls: grid.wall_segments ?? [] };
}

/** A token's chip: its first two letters, plus a stack badge when sharing a cell.
 *
 * Every class is nat20-namespaced because SillyTavern rewrites each class in
 * message HTML to `custom-<class>` (see `public/scripts/chats.js`'s
 * `uponSanitizeAttribute` hook) — a bare "floor" would become the generic,
 * collision-prone `custom-floor`. style.css therefore matches the prefixed
 * `.custom-nat20-*` forms.
 */
function tokenHtml(tok, badgeCount) {
    const classes = ['nat20-token', `nat20-${tok.side}`];
    if (tok.dead) classes.push('nat20-dead');
    if (tok.current) classes.push('nat20-current');
    const badge = badgeCount ? `<i class="nat20-stack">${badgeCount}</i>` : '';
    return `<span class="${classes.join(' ')}" title="${escapeHtml(tok.name)}">`
        + `${escapeHtml(String(tok.name).slice(0, 2))}${badge}</span>`;
}

/**
 * The battlefield as a self-contained HTML block for a chat message.
 *
 * Walls are corner-to-corner edges rather than cells (they block line of
 * sight, not movement), so they are drawn as an overlay rather than folded
 * into any cell's kind — same split as the demo template.
 *
 * @param {object} view A bridge GET /v1/combat/{cid} payload.
 * @returns {string} HTML, or a plain notice when the view carries no grid.
 */
export function renderGrid(view) {
    const { width, height, cells, walls } = buildGrid(view);
    if (!width || !height) return '<em>nat20: this combat reports no grid.</em>';

    const cellHtml = cells.map((cell) => {
        // The badge rides only the topmost (last-drawn) token — one count per
        // stack, not one per stacked combatant.
        const last = cell.tokens.length - 1;
        const tokens = cell.tokens.map((tok, i) =>
            tokenHtml(tok, i === last && cell.tokens.length > 1 ? cell.tokens.length : 0)).join('');
        return `<div class="nat20-cell nat20-${cell.kind}" title="${cell.cellId}">${tokens}</div>`;
    }).join('');

    const wallHtml = walls.map((wall) => {
        const horizontal = wall.y1 === wall.y2;
        const length = Math.abs(horizontal ? wall.x2 - wall.x1 : wall.y2 - wall.y1);
        const size = horizontal
            ? `width: calc(var(--nat20-cell) * ${length}); height: 2px;`
            : `width: 2px; height: calc(var(--nat20-cell) * ${length});`;
        return `<div class="nat20-wall" style="left: calc(var(--nat20-cell) * ${wall.x1});`
            + ` top: calc(var(--nat20-cell) * ${wall.y1}); ${size}"></div>`;
    }).join('');

    return `<div class="nat20-grid-wrap">`
        + `<div class="nat20-grid" style="--nat20-cols: ${width};">${cellHtml}</div>`
        + `<div class="nat20-walls">${wallHtml}</div>`
        + `</div>`;
}
