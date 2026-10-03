// Pure layout logic: grid metrics, tile packing, reflow, overflow counts and
// spatial navigation. No GI imports, so tests/ can run it in plain gjs.

// Reference unit on a 1920x1200 monitor with a 48px panel (work area 1152 high).
export const REF = {U: 156, V: 150, GX: 34, GY: 64, W: 1920, H: 1152};
export const MIN_SCALE = 0.66;
export const MAX_SCALE = 1.3;
export const MAX_COLS = 12;
export const MAX_ROWS = 6;
export const MAX_TILE_W = 4;
export const MAX_TILE_H = 3;

export const PILL_H = 60;
export const PILL_W = 820;
export const CHIP_OVERHANG = 36; // folder name chip: 8px gap + 28px chip

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Grid metrics for a work area. All values are logical pixels relative to the
 * monitor's top-left corner.
 *
 * @param {object} workArea - {x, y, width, height} relative to the monitor
 * @param {object} monitor - {width, height}
 * @param {object} opts - {clock: boolean}
 * @returns {object} metrics
 */
export function computeGrid(workArea, monitor, {clock = false} = {}) {
    let s = clamp(Math.min(workArea.width / REF.W, workArea.height / REF.H), MIN_SCALE, MAX_SCALE);
    let m;
    for (;;) {
        m = metricsFor(s, workArea, clock);
        if (m.rows >= 3 || s <= MIN_SCALE + 1e-6)
            break;
        s = Math.max(MIN_SCALE, s - 0.02);
    }
    return finishMetrics(m, workArea, monitor);
}

function metricsFor(s, wa, clock) {
    const U = Math.round(REF.U * s), V = Math.round(REF.V * s);
    const GX = Math.round(REF.GX * s), GY = Math.round(REF.GY * s);
    const headerGap = Math.round((clock ? 212 : 80) * s);
    const rowsFor = (top, bottom) => Math.floor(
        (wa.height - top - PILL_H - headerGap - CHIP_OVERHANG - bottom + GY) / (V + GY));

    // the sketch's spacing first; tighter margins only if that costs a row
    const prefTop = Math.round((clock ? 84 : 152) * s), prefBottom = Math.round(116 * s);
    const tightTop = Math.round(24 * s), tightBottom = Math.round(64 * s);
    let rows = rowsFor(prefTop, prefBottom), tight = false;
    if (rows < 3) {
        const r = rowsFor(tightTop, tightBottom);
        if (r > rows) {
            rows = r;
            tight = true;
        }
    }
    rows = clamp(rows, 1, MAX_ROWS);
    const side = Math.round(64 * s);
    const cols = clamp(Math.floor((wa.width - 2 * side + GX) / (U + GX)), 1, MAX_COLS);
    return {
        scale: s, U, V, GX, GY, cols, rows, clock, headerGap, tight,
        top: tight ? tightTop : prefTop,
        bottom: tight ? tightBottom : prefBottom,
    };
}

function finishMetrics(m, wa, monitor) {
    const boardW = m.cols * m.U + (m.cols - 1) * m.GX;
    const boardH = m.rows * m.V + (m.rows - 1) * m.GY;
    const used = m.top + PILL_H + m.headerGap + boardH + CHIP_OVERHANG + m.bottom;
    const spare = Math.max(0, wa.height - used);
    // the sketch keeps the board high and leaves the slack below; with tight
    // margins split it 40/60 so the block does not hug the panel
    const top = m.top + (m.tight ? Math.round(spare * 0.4) : 0);
    const pillY = wa.y + top;
    const boardY = pillY + PILL_H + m.headerGap;
    return {
        ...m,
        boardW, boardH,
        boardX: Math.round(wa.x + (wa.width - boardW) / 2),
        boardY,
        pillW: Math.min(PILL_W, monitor.width - 32),
        pillX: Math.round(wa.x + (wa.width - Math.min(PILL_W, monitor.width - 32)) / 2),
        pillY,
        clockY: pillY + PILL_H + Math.round(18 * m.scale),
        bottomY: boardY + boardH + CHIP_OVERHANG,
        workArea: wa,
        iconSize: names => Math.round((names ? 72 : 88) * m.scale),
        miniSize: names => Math.round((names ? 30 : 37) * m.scale),
        oneMiniSize: Math.round(46 * m.scale),
    };
}

/** Pixel rect of a grid rect, relative to the board origin of its page. */
export function cellRect(g, r) {
    return {
        x: r.x * (g.U + g.GX),
        y: r.y * (g.V + g.GY),
        width: r.w * g.U + (r.w - 1) * g.GX,
        height: r.h * g.V + (r.h - 1) * g.GY,
    };
}

// ---- occupancy ----

class Pages {
    constructor(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        this.pages = [];
    }

    _page(p) {
        while (this.pages.length <= p)
            this.pages.push(new Array(this.cols * this.rows).fill(null));
        return this.pages[p];
    }

    fits(p, x, y, w, h) {
        if (x < 0 || y < 0 || x + w > this.cols || y + h > this.rows)
            return false;
        const pg = this._page(p);
        for (let j = y; j < y + h; j++) {
            for (let i = x; i < x + w; i++) {
                if (pg[j * this.cols + i] !== null)
                    return false;
            }
        }
        return true;
    }

    put(id, p, x, y, w, h) {
        const pg = this._page(p);
        for (let j = y; j < y + h; j++) {
            for (let i = x; i < x + w; i++)
                pg[j * this.cols + i] = id;
        }
    }

    clear(p, x, y, w, h) {
        const pg = this._page(p);
        for (let j = y; j < y + h; j++) {
            for (let i = x; i < x + w; i++)
                pg[j * this.cols + i] = null;
        }
    }

    at(p, x, y) {
        return this.pages[p]?.[y * this.cols + x] ?? null;
    }
}

/**
 * First-fit packing: each item goes at the earliest free position (page,
 * row, column) where it fits, so later small tiles fill holes left by
 * earlier big ones. Items with `flex: true` and a 2-cell size may turn
 * 2x1 into 1x2 (or back) to fit earlier.
 *
 * @param {Array} items - [{id, w, h, flex?}] in priority order
 * @param {number} cols
 * @param {number} rows
 * @returns {object} id -> {page, x, y, w, h}
 */
export function firstFit(items, cols, rows) {
    const occ = new Pages(cols, rows);
    const out = {};
    for (const it of items) {
        const sizes = [[clamp(it.w, 1, cols), clamp(it.h, 1, rows)]];
        if (it.flex && it.w * it.h === 2)
            sizes.push([sizes[0][1], sizes[0][0]].map((v, i) => clamp(v, 1, i ? rows : cols)));
        let placed = null;
        for (let p = 0; !placed; p++) {
            for (let y = 0; y < rows && !placed; y++) {
                for (let x = 0; x < cols && !placed; x++) {
                    for (const [w, h] of sizes) {
                        if (occ.fits(p, x, y, w, h)) {
                            placed = {page: p, x, y, w, h};
                            break;
                        }
                    }
                }
            }
            if (p > 1000)
                throw new Error('firstFit: no space');
        }
        occ.put(it.id, placed.page, placed.x, placed.y, placed.w, placed.h);
        out[it.id] = placed;
    }
    return out;
}

/** Number of pages a layout uses. */
export function pageCount(tiles) {
    let n = 1;
    for (const t of Object.values(tiles))
        n = Math.max(n, t.page + 1);
    return n;
}

/**
 * Empty cells that leave a visible gap: a tile continues to their right on
 * the same row, or a tile starts on a later row of the same page. Space to
 * the right of the last tiles is not a hole. Every empty cell on a page
 * before the last one counts, since content continues on the next page.
 */
export function findHoles(tiles, cols, rows) {
    const occ = new Pages(cols, rows);
    for (const [id, t] of Object.entries(tiles))
        occ.put(id, t.page, t.x, t.y, t.w, t.h);
    const holes = [];
    const last = pageCount(tiles) - 1;
    for (let p = 0; p <= last; p++) {
        const onPage = Object.values(tiles).filter(t => t.page === p);
        const lastStart = onPage.reduce((m, t) => Math.max(m, t.y), -1);
        for (let y = 0; y < rows; y++) {
            let rightmost = -1;
            for (let x = 0; x < cols; x++) {
                if (occ.at(p, x, y) !== null)
                    rightmost = x;
            }
            for (let x = 0; x < cols; x++) {
                if (occ.at(p, x, y) !== null)
                    continue;
                if (p < last || x < rightmost || y < lastStart)
                    holes.push({page: p, x, y});
            }
        }
    }
    return holes;
}

/**
 * Removes holes: first by growing a neighbouring tile that has enough apps
 * to fill the extra slots, then by moving the last 1x1 tile into the hole.
 * Holes that neither can fix stay. Mutates and returns tiles.
 *
 * @param {object} tiles - id -> rect
 * @param {number} cols
 * @param {number} rows
 * @param {object} counts - id -> number of apps
 */
export function fillHoles(tiles, cols, rows, counts = {}) {
    for (let guard = 0; guard < 200; guard++) {
        const holes = findHoles(tiles, cols, rows);
        if (!holes.length)
            break;
        const occ = new Pages(cols, rows);
        for (const [id, t] of Object.entries(tiles))
            occ.put(id, t.page, t.x, t.y, t.w, t.h);
        const useful = (id, r) => (counts[id] ?? 0) >= r.w * r.h;
        let fixed = false;
        for (const hole of holes) {
            const cands = [];
            for (const [id, t] of Object.entries(tiles)) {
                if (t.page !== hole.page)
                    continue;
                const grow = [];
                if (t.x + t.w === hole.x && hole.y >= t.y && hole.y < t.y + t.h && t.w < MAX_TILE_W &&
                    occ.fits(t.page, hole.x, t.y, 1, t.h))
                    grow.push({...t, w: t.w + 1});
                if (t.y + t.h === hole.y && hole.x >= t.x && hole.x < t.x + t.w && t.h < MAX_TILE_H &&
                    occ.fits(t.page, t.x, hole.y, t.w, 1))
                    grow.push({...t, h: t.h + 1});
                if (t.x - 1 === hole.x && hole.y >= t.y && hole.y < t.y + t.h && t.w < MAX_TILE_W &&
                    occ.fits(t.page, hole.x, t.y, 1, t.h))
                    grow.push({...t, x: t.x - 1, w: t.w + 1});
                for (const r of grow)
                    cands.push({id, r, useful: useful(id, r)});
            }
            const good = cands.filter(c => c.useful);
            if (good.length) {
                good.sort((a, b) => a.r.w * a.r.h - b.r.w * b.r.h);
                tiles[good[0].id] = good[0].r;
                fixed = true;
                break;
            }
            // move the last tile (reading order) into the hole if it fits
            const order = readingOrder(tiles);
            const lastId = order[order.length - 1];
            const lt = tiles[lastId];
            const after = lt.page > hole.page || (lt.page === hole.page &&
                (lt.y > hole.y || (lt.y === hole.y && lt.x > hole.x)));
            if (after) {
                occ.clear(lt.page, lt.x, lt.y, lt.w, lt.h);
                if (occ.fits(hole.page, hole.x, hole.y, lt.w, lt.h)) {
                    tiles[lastId] = {page: hole.page, x: hole.x, y: hole.y, w: lt.w, h: lt.h};
                    fixed = true;
                    break;
                }
                occ.put(lastId, lt.page, lt.x, lt.y, lt.w, lt.h);
            }
            // last resort: a tile with a spare slot beats a hole in the grid;
            // pick the growth that leaves the fewest empty slots
            if (cands.length) {
                const waste = c => c.r.w * c.r.h - (counts[c.id] ?? 0);
                cands.sort((a, b) => waste(a) - waste(b));
                tiles[cands[0].id] = cands[0].r;
                fixed = true;
                break;
            }
        }
        if (!fixed)
            break;
    }
    return tiles;
}

/**
 * Tile sizes for a generated layout. Folders are ranked by usage: the top
 * two get 3x2 and 2x2, the middle get 2 cells, the rest 1x1. No tile gets
 * more slots than it has apps. If everything would not fit on one page,
 * tiles are shrunk from the middle up before a second page is used.
 *
 * @param {Array} folders - [{id, count}] most used first
 * @param {number} cols
 * @param {number} rows
 * @returns {Array} [{id, w, h, flex}]
 */
export function planSizes(folders, cols, rows) {
    const n = folders.length;
    const ladder = [[3, 2], [2, 2], [2, 1], [1, 1]];
    const nMid = Math.ceil(Math.max(0, n - 2) / 2);
    const want = folders.map((f, i) => {
        let step = i === 0 ? 0 : i === 1 ? 1 : i < 2 + nMid ? 2 : 3;
        // never more slots than apps
        while (step < 3 && ladder[step][0] * ladder[step][1] > Math.max(1, f.count))
            step++;
        // and never wider or taller than the grid
        while (step < 3 && (ladder[step][0] > cols || ladder[step][1] > rows))
            step++;
        return step;
    });
    const area = st => ladder[st][0] * ladder[st][1];
    const cells = () => want.reduce((a, st) => a + area(st), 0);
    const capacity = cols * rows;
    // shrink the smallest non-1x1 tile, lowest ranked first, until it fits
    for (let guard = 0; cells() > capacity && guard < 4 * n; guard++) {
        let k = -1;
        for (let i = n - 1; i >= 0; i--) {
            if (want[i] < 3 && (k < 0 || want[i] > want[k]))
                k = i;
        }
        if (k < 0)
            break;
        want[k]++;
    }
    // then grow into spare cells, most used first, one step at a time, as
    // long as the folder has the apps to fill the new slots
    for (let grew = true, guard = 0; grew && guard < 8 * n; guard++) {
        grew = false;
        for (let i = 0; i < n; i++) {
            const next = want[i] - 1;
            if (next < 0)
                continue;
            const [w, h] = ladder[next];
            if (w > cols || h > rows || w * h > folders[i].count)
                continue;
            // only the most used folder can be 3x2; growth goes in rank
            // order, so better ranked folders get the space first
            if (next < (i === 0 ? 0 : 1))
                continue;
            if (cells() - area(want[i]) + w * h > capacity)
                continue;
            want[i] = next;
            grew = true;
            break;
        }
    }
    return folders.map((f, i) => ({
        id: f.id,
        w: ladder[want[i]][0],
        h: ladder[want[i]][1],
        flex: want[i] === 2,
    }));
}

/** Generated first-run layout. */
export function generateLayout(folders, cols, rows) {
    const counts = Object.fromEntries(folders.map(f => [f.id, f.count]));
    let plan = planSizes(folders, cols, rows);
    for (let guard = 0; guard < 4 * plan.length + 1; guard++) {
        const cells = plan.reduce((a, p) => a + p.w * p.h, 0);
        const tiles = firstFit(plan, cols, rows);
        // packing can fragment; if a page too many is used, shrink the
        // lowest ranked tile that is not 1x1 and try again
        if (pageCount(tiles) <= Math.max(1, Math.ceil(cells / (cols * rows))))
            return fillHoles(tiles, cols, rows, counts);
        const k = plan.map(p => p.w * p.h > 1).lastIndexOf(true);
        if (k < 0)
            return fillHoles(tiles, cols, rows, counts);
        const p = plan[k];
        plan = plan.slice();
        plan[k] = p.w * p.h > 2 ? {...p, w: p.w === 3 ? 2 : p.w, h: p.w === 3 ? p.h : 1, flex: p.w * p.h === 4}
            : {...p, w: 1, h: 1, flex: false};
    }
    return fillHoles(firstFit(plan, cols, rows), cols, rows, counts);
}

/** Reading order of a layout: page, then row, then column. */
export function readingOrder(tiles) {
    return Object.entries(tiles)
        .sort(([, a], [, b]) => a.page - b.page || a.y - b.y || a.x - b.x)
        .map(([id]) => id);
}

/**
 * Reflows a layout made for another grid: keeps the reading order and each
 * tile's size (clamped to the new grid) and packs first-fit.
 */
export function reflow(tiles, cols, rows) {
    const items = readingOrder(tiles).map(id => ({
        id,
        w: Math.min(tiles[id].w, cols),
        h: Math.min(tiles[id].h, rows),
    }));
    return firstFit(items, cols, rows);
}

/** True if a rect is inside the grid and overlaps none of the other tiles. */
export function canPlace(tiles, id, r, cols, rows) {
    if (r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > cols || r.y + r.h > rows)
        return false;
    for (const [oid, o] of Object.entries(tiles)) {
        if (oid === id || o.page !== r.page)
            continue;
        if (r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h)
            return false;
    }
    return true;
}

/**
 * Makes a stored layout valid for the current folders and grid: drops
 * folders that no longer exist, repacks tiles that are out of bounds or
 * overlapping, and appends new folders first-fit after the existing ones.
 * Nothing is ever dropped for lack of space; extra pages are added.
 *
 * @param {object} tiles - stored id -> rect
 * @param {Array} folderIds - current folders, most used first
 * @param {number} cols
 * @param {number} rows
 * @returns {object} id -> rect
 */
export function reconcile(tiles, folderIds, cols, rows) {
    const live = new Set(folderIds);
    const kept = {};
    const occ = new Pages(cols, rows);
    const bad = [];
    for (const id of readingOrder(tiles)) {
        if (!live.has(id))
            continue;
        const t = tiles[id];
        const ok = Number.isInteger(t.page) && t.page >= 0 && t.w >= 1 && t.h >= 1 &&
            t.w <= MAX_TILE_W && t.h <= MAX_TILE_H && occ.fits(t.page, t.x, t.y, t.w, t.h);
        if (ok) {
            kept[id] = {page: t.page, x: t.x, y: t.y, w: t.w, h: t.h};
            occ.put(id, t.page, t.x, t.y, t.w, t.h);
        } else {
            bad.push({id, w: clamp(t.w | 0, 1, Math.min(cols, MAX_TILE_W)), h: clamp(t.h | 0, 1, Math.min(rows, MAX_TILE_H))});
        }
    }
    for (const id of folderIds) {
        if (!(id in kept) && !bad.some(b => b.id === id))
            bad.push({id, w: 1, h: 1});
    }
    for (const it of bad) {
        let placed = null;
        for (let p = 0; !placed; p++) {
            for (let y = 0; y < rows && !placed; y++) {
                for (let x = 0; x < cols && !placed; x++) {
                    if (occ.fits(p, x, y, it.w, it.h))
                        placed = {page: p, x, y, w: it.w, h: it.h};
                }
            }
        }
        kept[it.id] = placed;
        occ.put(it.id, placed.page, placed.x, placed.y, placed.w, placed.h);
    }
    return kept;
}

/**
 * Picks the stored or derived layout for a grid.
 *
 * Stored format: {version: 1, last: "COLSxROWS", grids: {"COLSxROWS":
 * {tiles, generated}}}. A grid with a stored layout keeps it. A grid never
 * seen is reflowed from the most recently edited layout, or generated if the
 * user never edited one (a generated layout carries no preference to keep).
 *
 * @returns {{tiles: object, source: string}} source is stored|reflowed|generated
 */
export function resolveLayout(stored, folders, cols, rows) {
    const key = `${cols}x${rows}`;
    const ids = folders.map(f => f.id);
    const grids = stored?.grids ?? {};
    if (grids[key]?.tiles)
        return {tiles: reconcile(grids[key].tiles, ids, cols, rows), source: 'stored'};
    const last = stored?.last && grids[stored.last];
    if (last?.tiles && !last.generated) {
        const live = Object.fromEntries(Object.entries(last.tiles).filter(([id]) => ids.includes(id)));
        return {tiles: reconcile(reflow(live, cols, rows), ids, cols, rows), source: 'reflowed'};
    }
    return {tiles: generateLayout(folders, cols, rows), source: 'generated'};
}

/**
 * Returns a new stored object with `tiles` saved for this grid. An edit
 * becomes the layout other grids reflow from; a generated one does not.
 */
export function storeLayout(stored, cols, rows, tiles, {generated = false} = {}) {
    const key = `${cols}x${rows}`;
    const grids = {...(stored?.grids ?? {})};
    const clean = {};
    for (const [id, t] of Object.entries(tiles))
        clean[id] = {page: t.page, x: t.x, y: t.y, w: t.w, h: t.h};
    grids[key] = generated ? {tiles: clean, generated: true} : {tiles: clean};
    const prev = stored?.last;
    const last = generated && prev && grids[prev] && !grids[prev].generated ? prev : key;
    return {version: 1, last, grids};
}

// ---- tile contents ----

/**
 * What a w x h tile shows for n apps.
 *
 * @returns {{big: number, mini: number, badge: number}} big icons, apps in
 *   the mini preview, and the +N count of apps not visible anywhere
 */
export function tileContent(n, w, h) {
    const slots = w * h;
    if (slots === 1) {
        const mini = Math.min(4, n);
        return {big: 0, mini, badge: n - mini};
    }
    if (n <= slots)
        return {big: n, mini: 0, badge: 0};
    const big = slots - 1;
    const mini = Math.min(4, n - big);
    return {big, mini, badge: n - big - mini};
}

// ---- spatial navigation ----

/**
 * Index of the best candidate in direction (dx, dy) from `from`, or -1.
 * Rects are {x, y, width, height}. Score: distance along the direction plus
 * 2.2x the sideways offset, between centres; candidates must be ahead.
 */
export function pickNeighbor(from, candidates, dx, dy) {
    const cx = from.x + from.width / 2, cy = from.y + from.height / 2;
    let best = -1, bestScore = Infinity;
    candidates.forEach((r, i) => {
        if (r === from)
            return;
        const vx = r.x + r.width / 2 - cx, vy = r.y + r.height / 2 - cy;
        const along = vx * dx + vy * dy;
        if (along <= 4)
            return;
        const perp = Math.abs(vx * dy - vy * dx);
        const score = along + perp * 2.2;
        if (score < bestScore) {
            bestScore = score;
            best = i;
        }
    });
    return best;
}
