// Unit tests for the pure layout logic. Run: gjs -m tests/test-layout.js
import * as L from '../src/lib/layoutEngine.js';

let failures = 0, passes = 0;
function ok(cond, msg) {
    if (cond) {
        passes++;
    } else {
        failures++;
        print(`FAIL: ${msg}`);
    }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

function overlaps(tiles) {
    const e = Object.entries(tiles);
    for (let i = 0; i < e.length; i++) {
        for (let j = i + 1; j < e.length; j++) {
            const [, a] = e[i], [, b] = e[j];
            if (a.page === b.page && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
                return `${e[i][0]} overlaps ${e[j][0]}`;
        }
    }
    return null;
}
function inBounds(tiles, cols, rows) {
    return Object.values(tiles).every(t => t.x >= 0 && t.y >= 0 && t.x + t.w <= cols && t.y + t.h <= rows);
}

// ---- grid metrics at the target resolutions ----
const targets = [
    // name, monitor (logical), work area relative to monitor
    ['1920x1200 Dash to Panel', {width: 1920, height: 1200}, {x: 0, y: 48, width: 1920, height: 1152}],
    ['1366x768 stock panel', {width: 1366, height: 768}, {x: 0, y: 32, width: 1366, height: 736}],
    ['1920x1080 Ubuntu Dock left', {width: 1920, height: 1080}, {x: 70, y: 32, width: 1850, height: 1048}],
    ['2560x1440 stock panel', {width: 2560, height: 1440}, {x: 0, y: 32, width: 2560, height: 1408}],
    ['3840x2160 at 200% (1920x1080 logical)', {width: 1920, height: 1080}, {x: 0, y: 32, width: 1920, height: 1048}],
    ['3440x1440 stock panel', {width: 3440, height: 1440}, {x: 0, y: 32, width: 3440, height: 1408}],
];
for (const clock of [false, true]) {
    for (const [name, mon, wa] of targets) {
        const g = L.computeGrid(wa, mon, {clock});
        print(`${name}${clock ? ' +clock' : ''}: ${g.cols}x${g.rows}, U=${g.U} V=${g.V} s=${g.scale.toFixed(2)} board ${g.boardX},${g.boardY} ${g.boardW}x${g.boardH} pill y=${g.pillY} bottom=${g.bottomY}${g.tight ? ' tight' : ''}`);
        ok(g.rows >= 3, `${name}: at least 3 rows`);
        ok(g.cols >= 8, `${name}: at least 8 columns`);
        ok(g.boardX >= wa.x && g.boardX + g.boardW <= wa.x + wa.width, `${name}: board inside work area horizontally`);
        ok(g.bottomY <= wa.y + wa.height, `${name}: board and chips inside work area vertically`);
        ok(g.pillX >= 0 && g.pillX + g.pillW <= mon.width, `${name}: search field on screen`);
    }
}
{
    const g = L.computeGrid({x: 0, y: 48, width: 1920, height: 1152}, {width: 1920, height: 1200});
    eq([g.cols, g.rows, g.U, g.V, g.GX, g.GY], [9, 3, 156, 150, 34, 64], 'reference grid is 9x3 at U=156');
    eq([g.boardX, g.boardY, g.pillY], [122, 340, 200], 'reference positions match the sketch (no clock)');
    const c = L.computeGrid({x: 0, y: 48, width: 1920, height: 1152}, {width: 1920, height: 1200}, {clock: true});
    eq([c.cols, c.rows, c.boardY, c.pillY], [9, 3, 404, 132], 'reference positions match the sketch (clock)');
}

// ---- tile contents and +N ----
eq(L.tileContent(10, 3, 2), {big: 5, mini: 4, badge: 1}, '3x2 with 10 apps');
eq(L.tileContent(6, 3, 2), {big: 6, mini: 0, badge: 0}, '3x2 with exactly 6 apps');
eq(L.tileContent(7, 3, 2), {big: 5, mini: 2, badge: 0}, '3x2 with 7 apps: no badge when all visible');
eq(L.tileContent(4, 1, 1), {big: 0, mini: 4, badge: 0}, '1x1 with 4 apps');
eq(L.tileContent(9, 1, 1), {big: 0, mini: 4, badge: 5}, '1x1 with 9 apps');
eq(L.tileContent(3, 1, 1), {big: 0, mini: 3, badge: 0}, '1x1 with 3 apps');
eq(L.tileContent(11, 1, 2), {big: 1, mini: 4, badge: 6}, '1x2 with 11 apps (Utilities in the sketch: +6)');
eq(L.tileContent(2, 2, 1), {big: 2, mini: 0, badge: 0}, '2x1 with 2 apps');
eq(L.tileContent(0, 2, 2), {big: 0, mini: 0, badge: 0}, 'empty');

// ---- first fit ----
{
    const t = L.firstFit([{id: 'a', w: 3, h: 2}, {id: 'b', w: 2, h: 2}, {id: 'c', w: 1, h: 1}], 9, 3);
    eq(t.a, {page: 0, x: 0, y: 0, w: 3, h: 2}, 'first tile at origin');
    eq(t.b, {page: 0, x: 3, y: 0, w: 2, h: 2}, 'second next to it');
    eq(t.c, {page: 0, x: 5, y: 0, w: 1, h: 1}, 'small fills next cell');
    ok(!overlaps(t), 'no overlap');
}
{
    // later small tile fills a hole left by a big one
    const t = L.firstFit([{id: 'a', w: 3, h: 1}, {id: 'b', w: 3, h: 2}, {id: 'c', w: 1, h: 1}], 4, 3);
    eq(t.b, {page: 0, x: 0, y: 1, w: 3, h: 2}, 'big tile wraps to next row');
    eq(t.c, {page: 0, x: 3, y: 0, w: 1, h: 1}, 'small tile fills the gap at row end');
}
{
    // flex 2-cell turns vertical to fit
    const t = L.firstFit([{id: 'a', w: 3, h: 2}, {id: 'b', w: 2, h: 1, flex: true}], 4, 3);
    eq(t.b, {page: 0, x: 3, y: 0, w: 1, h: 2}, 'flex tile turns 1x2 to use the last column');
}
{
    // overflow goes to page 2, nothing dropped
    const items = Array.from({length: 30}, (_, i) => ({id: `f${i}`, w: 1, h: 1}));
    const t = L.firstFit(items, 9, 3);
    eq(Object.keys(t).length, 30, 'all 30 placed');
    eq(L.pageCount(t), 2, 'two pages');
    eq(t.f27, {page: 1, x: 0, y: 0, w: 1, h: 1}, 'the 28th starts page 2');
}

// ---- generated layouts: no holes, no overlap, fits ----
function folderSet(counts) {
    return counts.map((c, i) => ({id: `g${i}`, count: c}));
}
const sets = {
    'sketch (11 folders)': [10, 6, 11, 9, 4, 3, 10, 7, 6, 9, 4],
    'author (10 folders)': [11, 11, 16, 6, 6, 2, 5, 3, 20, 14],
    'one big folder': [40],
    'three folders': [12, 5, 2],
    'many small': Array.from({length: 26}, () => 2),
    'twenty mixed': Array.from({length: 20}, (_, i) => 3 + (i * 7) % 11),
};
for (const [name, counts] of Object.entries(sets)) {
    for (const [cols, rows] of [[9, 3], [8, 3], [10, 3], [11, 4], [12, 4]]) {
        const folders = folderSet(counts);
        const t = L.generateLayout(folders, cols, rows);
        const o = overlaps(t);
        ok(!o, `${name} ${cols}x${rows}: ${o}`);
        ok(inBounds(t, cols, rows), `${name} ${cols}x${rows}: in bounds`);
        eq(Object.keys(t).length, folders.length, `${name} ${cols}x${rows}: every folder placed`);
        const holes = L.findHoles(t, cols, rows);
        ok(holes.length === 0, `${name} ${cols}x${rows}: no holes, got ${JSON.stringify(holes)}`);
        for (const f of folders) {
            const r = t[f.id];
            // at most two empty slots, and only where that closes a hole
            ok(r.w * r.h <= Math.max(2, f.count + 2),
                `${name} ${cols}x${rows}: ${f.id} (${f.count} apps) not oversized at ${r.w}x${r.h}`);
        }
        const cells = folders.reduce((a, f) => a + t[f.id].w * t[f.id].h, 0);
        if (cells <= cols * rows)
            eq(L.pageCount(t), 1, `${name} ${cols}x${rows}: fits on one page`);
    }
}
{
    const t = L.generateLayout(folderSet(sets['sketch (11 folders)']), 9, 3);
    eq([t.g0.w, t.g0.h, t.g1.w, t.g1.h], [3, 2, 2, 2], 'top two folders get 3x2 and 2x2');
}

// ---- reflow keeps order, and reconcile never drops ----
{
    const t = L.generateLayout(folderSet(sets['sketch (11 folders)']), 9, 3);
    const order = L.readingOrder(t);
    for (const [cols, rows] of [[8, 3], [12, 4], [6, 2], [4, 3]]) {
        const r = L.reflow(t, cols, rows);
        ok(!overlaps(r) && inBounds(r, cols, rows), `reflow to ${cols}x${rows} valid`);
        eq(Object.keys(r).length, order.length, `reflow to ${cols}x${rows} keeps every tile`);
        const sizes = order.map(id => [Math.min(t[id].w, cols), Math.min(t[id].h, rows)]);
        eq(order.map(id => [r[id].w, r[id].h]), sizes, `reflow to ${cols}x${rows} keeps sizes`);
        // order: the first tile stays first
        eq(L.readingOrder(r)[0], order[0], `reflow to ${cols}x${rows} keeps the first tile first`);
    }
}
{
    const stored = {a: {page: 0, x: 0, y: 0, w: 2, h: 2}, gone: {page: 0, x: 2, y: 0, w: 1, h: 1},
        b: {page: 0, x: 1, y: 1, w: 1, h: 1} /* overlaps a */, c: {page: 0, x: 8, y: 0, w: 3, h: 1} /* out of bounds */};
    const r = L.reconcile(stored, ['a', 'b', 'c', 'new1', 'new2'], 9, 3);
    ok(!('gone' in r), 'deleted folder removed');
    eq(Object.keys(r).sort(), ['a', 'b', 'c', 'new1', 'new2'], 'all live folders present');
    ok(!overlaps(r) && inBounds(r, 9, 3), 'reconciled layout valid');
    eq(r.a, stored.a, 'valid tile untouched');
}
{
    // full grid: new folder goes to a new page, not dropped
    const full = {};
    for (let i = 0; i < 27; i++)
        full[`f${i}`] = {page: 0, x: i % 9, y: Math.floor(i / 9), w: 1, h: 1};
    const r = L.reconcile(full, [...Object.keys(full), 'extra'], 9, 3);
    eq(r.extra, {page: 1, x: 0, y: 0, w: 1, h: 1}, 'new folder on a full grid opens page 2');
}

// ---- resolve / store ----
{
    const folders = folderSet(sets['sketch (11 folders)']);
    const first = L.resolveLayout({}, folders, 9, 3);
    eq(first.source, 'generated', 'first run generates');
    let stored = L.storeLayout({}, 9, 3, first.tiles, {generated: true});
    const again = L.resolveLayout(stored, folders, 9, 3);
    eq(again.source, 'stored', 'same grid uses the stored layout');
    eq(again.tiles, first.tiles, 'stored layout round-trips');
    eq(L.resolveLayout(stored, folders, 10, 3).source, 'generated', 'never edited: another grid gets its own generated layout');
    // the user edits on 9x3
    const edited = {...first.tiles, g0: {...first.tiles.g0}};
    stored = L.storeLayout(stored, 9, 3, edited);
    const other = L.resolveLayout(stored, folders, 12, 4);
    eq(other.source, 'reflowed', 'after an edit, other grids reflow from it');
    // storing a generated layout elsewhere keeps the edited one as the source
    stored = L.storeLayout(stored, 8, 3, L.generateLayout(folders, 8, 3), {generated: true});
    eq(stored.last, '9x3', 'a generated layout does not replace the last edited one');
    // an edit on 12x4 does not overwrite the 9x3 layout
    stored = L.storeLayout(stored, 12, 4, other.tiles);
    eq(L.resolveLayout(stored, folders, 9, 3).tiles, edited, '9x3 keeps its own layout after a 12x4 edit');
    eq(L.resolveLayout(stored, folders, 10, 3).source, 'reflowed', 'unseen grid reflows');
    stored = JSON.parse(JSON.stringify(stored));
    eq(stored.last, '12x4', 'last edited grid recorded');
}

// ---- canPlace ----
{
    const t = {a: {page: 0, x: 0, y: 0, w: 2, h: 2}, b: {page: 0, x: 2, y: 0, w: 1, h: 1}};
    ok(L.canPlace(t, 'b', {page: 0, x: 3, y: 0, w: 1, h: 1}, 9, 3), 'move into free cell');
    ok(!L.canPlace(t, 'b', {page: 0, x: 1, y: 0, w: 1, h: 1}, 9, 3), 'overlap rejected');
    ok(!L.canPlace(t, 'b', {page: 0, x: 8, y: 0, w: 2, h: 1}, 9, 3), 'out of bounds rejected');
    ok(L.canPlace(t, 'a', {page: 0, x: 0, y: 0, w: 2, h: 3}, 9, 3), 'resize own area');
    ok(L.canPlace(t, 'b', {page: 1, x: 0, y: 0, w: 1, h: 1}, 9, 3), 'other page is free');
}

// ---- spatial navigation ----
{
    const r = (x, y, w = 100, h = 100) => ({x, y, width: w, height: h});
    // a row of three, a row below
    const items = [r(0, 0), r(200, 0), r(400, 0), r(0, 200), r(200, 200), r(600, 220)];
    eq(L.pickNeighbor(items[0], items, 1, 0), 1, 'right goes to the next in the row');
    eq(L.pickNeighbor(items[0], items, 0, 1), 3, 'down goes straight down');
    eq(L.pickNeighbor(items[2], items, 0, 1), 4, 'down from the right end picks the nearest below');
    eq(L.pickNeighbor(items[0], items, -1, 0), -1, 'nothing to the left');
    eq(L.pickNeighbor(items[4], items, 0, -1), 1, 'up from below goes to the one above');
    eq(L.pickNeighbor(items[1], items, 1, 0), 2, 'right prefers the same row over a nearer diagonal');
    // big tile next to small ones: from a small cell to the right, then left again
    const mixed = [r(0, 0, 300, 300), r(320, 0), r(320, 200)];
    eq(L.pickNeighbor(mixed[2], mixed, -1, 0), 0, 'left from a small cell reaches the big tile');
}

print(`\n${passes} passed, ${failures} failed`);
if (failures)
    imports.system.exit(1);
