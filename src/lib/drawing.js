// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Cairo helpers. St has no dashed borders, so the edit-mode outlines and
// the empty-cell placeholders are drawn.

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/**
 * Strokes (and optionally fills) dashed rounded rectangles on a
 * St.DrawingArea, from its repaint handler.
 *
 * @param {St.DrawingArea} area
 * @param {Array} rects - [{x, y, width, height}]
 * @param {object} style - colours as [r, g, b, a] in 0..1
 */
export function drawDashed(area, rects, {rgba, fill = null, radius = 32, width = 1.5, dash = [6, 4]}) {
    const cr = area.get_context();
    cr.setLineWidth(width);
    cr.setDash(dash, 0);
    for (const r of rects) {
        roundedRect(cr, r.x + width / 2, r.y + width / 2, r.width - width, r.height - width, radius);
        if (fill) {
            cr.setSourceRGBA(...fill);
            cr.fillPreserve();
        }
        cr.setSourceRGBA(...rgba);
        cr.stroke();
    }
    cr.$dispose();
}
