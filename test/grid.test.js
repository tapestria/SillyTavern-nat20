import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildGrid, renderGrid } from '../grid.js';

/** A bridge GET /v1/combat/{cid} payload, overridable per test. */
function view({ order = [], grid = {}, current_actor = '' } = {}) {
    return {
        round_number: 1,
        current_actor,
        ended: false,
        order,
        grid: {
            width: 3,
            height: 2,
            cell_size_ft: 5,
            blocked_cells: [],
            difficult_terrain_cells: [],
            cover_cells: {},
            wall_segments: [],
            ...grid,
        },
    };
}

function combatant(entity_id, zone, extra = {}) {
    return { entity_id, name: entity_id.split(':')[1], hp: 5, max_hp: 5, dead: false, conditions: [], zone, ...extra };
}

test('builds one cell per square in row-major order', () => {
    const { width, height, cells } = buildGrid(view());

    assert.equal(width, 3);
    assert.equal(height, 2);
    assert.deepEqual(cells.map((c) => c.cellId), ['0,0', '1,0', '2,0', '0,1', '1,1', '2,1']);
});

test('places a combatant token in the cell named by its zone', () => {
    const { cells } = buildGrid(view({ order: [combatant('char:elara', '2,1')] }));

    const occupied = cells.filter((c) => c.tokens.length > 0);
    assert.equal(occupied.length, 1);
    assert.equal(occupied[0].cellId, '2,1');
    assert.equal(occupied[0].tokens[0].name, 'elara');
});

test('sides a token by its entity-id prefix', () => {
    const { cells } = buildGrid(view({
        order: [combatant('char:elara', '0,0'), combatant('mon:goblin-warrior-1', '1,0')],
    }));

    assert.equal(cells[0].tokens[0].side, 'pc');
    assert.equal(cells[1].tokens[0].side, 'foe');
});

test('marks the current actor', () => {
    const { cells } = buildGrid(view({
        order: [combatant('char:elara', '0,0'), combatant('mon:goblin-warrior-1', '1,0')],
        current_actor: 'mon:goblin-warrior-1 (Goblin Warrior 1)',
    }));

    assert.equal(cells[0].tokens[0].current, false);
    assert.equal(cells[1].tokens[0].current, true);
});

test('marks a dead combatant', () => {
    const { cells } = buildGrid(view({ order: [combatant('mon:goblin-minion-1', '0,0', { dead: true })] }));

    assert.equal(cells[0].tokens[0].dead, true);
});

test('keeps every combatant when several share one cell', () => {
    // The engine permits co-occupancy (spatial.py::is_passable checks bounds
    // and impassability only), so a renderer that keeps one token per cell
    // silently hides combatants — apps/demo's last-writer-wins does exactly
    // that. Stacked tokens must all survive the build.
    const { cells } = buildGrid(view({
        order: [combatant('char:brakk', '0,1'), combatant('mon:goblin-warrior-3', '0,1')],
    }));

    const stacked = cells.find((c) => c.cellId === '0,1');
    assert.deepEqual(stacked.tokens.map((t) => t.entityId), ['char:brakk', 'mon:goblin-warrior-3']);
});

test('kinds a cell by its terrain, with blocked winning over difficult', () => {
    const { cells } = buildGrid(view({
        grid: {
            blocked_cells: ['0,0'],
            difficult_terrain_cells: ['0,0', '1,0'],
            cover_cells: { '2,0': 'half' },
        },
    }));

    const kinds = Object.fromEntries(cells.map((c) => [c.cellId, c.kind]));
    assert.equal(kinds['0,0'], 'blocked');
    assert.equal(kinds['1,0'], 'difficult');
    assert.equal(kinds['2,0'], 'cover_half');
    assert.equal(kinds['0,1'], 'floor');
});

test('passes wall segments through for the renderer to draw', () => {
    const wall = { x1: 0, y1: 1, x2: 3, y2: 1 };
    const { walls } = buildGrid(view({ grid: { wall_segments: [wall] } }));

    assert.deepEqual(walls, [wall]);
});

test('tolerates a combatant standing off the reported grid', () => {
    // A zone outside the grid must not throw or invent a cell — the bridge
    // is the authority on both, and a mismatch is a bug worth seeing, not
    // one worth crashing the chat over.
    const built = buildGrid(view({ order: [combatant('char:elara', '9,9')] }));

    assert.equal(built.cells.length, 6);
    assert.ok(built.cells.every((c) => c.tokens.length === 0));
});

test('renders one stack badge per stacked cell, not one per token', () => {
    const html = renderGrid(view({
        order: [combatant('char:brakk', '0,1'), combatant('mon:g3', '0,1'), combatant('mon:g4', '0,1')],
    }));

    const badges = [...html.matchAll(/nat20-stack/g)];
    assert.equal(badges.length, 1);
    assert.match(html, />3</);
});

test('falls back to a notice when the bridge sends no grid block', () => {
    // Bridges older than the grid-block change return a view with no `grid`.
    // The README promises a notice rather than a broken or empty map.
    const html = renderGrid({ round_number: 1, current_actor: '', ended: false, order: [] });

    assert.match(html, /no grid/i);
    assert.doesNotMatch(html, /nat20-cell/);
});

test('renders a combatant name into the grid html', () => {
    const html = renderGrid(view({ order: [combatant('char:elara', '0,0')] }));

    assert.match(html, /nat20-grid/);
    assert.match(html, /elara/i);
});

test('namespaces every class so ST class-prefixing stays collision-free', () => {
    // SillyTavern rewrites every class in message HTML to `custom-<class>`
    // (chats.js `uponSanitizeAttribute`), per token. A bare class like
    // "floor" would land as the generic, collision-prone `custom-floor`, so
    // every class this module emits must already carry the nat20- namespace.
    const html = renderGrid(view({
        order: [combatant('char:elara', '0,0', { dead: true }), combatant('mon:g', '0,0')],
        grid: { blocked_cells: ['1,0'], difficult_terrain_cells: ['2,0'], cover_cells: { '1,1': 'half' } },
        current_actor: 'char:elara (Elara)',
    }));

    const classes = [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(' '));
    assert.ok(classes.length > 0);
    for (const cls of classes) {
        assert.ok(cls.startsWith('nat20-'), `class "${cls}" is not nat20-namespaced`);
    }
});

test('escapes html in combatant names', () => {
    const html = renderGrid(view({ order: [combatant('char:x', '0,0', { name: '<img src=x>' })] }));

    assert.doesNotMatch(html, /<img/);
});
