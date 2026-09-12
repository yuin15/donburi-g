"""Build an enamel seven and an editable, freestanding slot cabinet in Houdini.

The cabinet uses metres-like units: 100 stage pixels = one unit. Its origin is
the centre of the lower plinth. Front is +Z, up is +Y. No account data is read.
"""

from pathlib import Path
import json
import math
import hou
from build_symbols import Model


def ccw(path):
    clean = []
    for p in path:
        if not clean or math.hypot(p[0] - clean[-1][0], p[1] - clean[-1][1]) > 1e-9:
            clean.append(p)
    if math.hypot(clean[0][0] - clean[-1][0], clean[0][1] - clean[-1][1]) < 1e-9:
        clean.pop()
    path = clean
    area = sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(path, path[1:] + path[:1]))
    return path if area > 0 else list(reversed(path))


def inset(path, amount):
    result = []
    for i, (x, y) in enumerate(path):
        px, py = path[i - 1]
        qx, qy = path[(i + 1) % len(path)]
        a, b = math.hypot(x - px, y - py), math.hypot(qx - x, qy - y)
        n, m = (-(y - py) / a, (x - px) / a), (-(qy - y) / b, (qx - x) / b)
        distance = amount / max(.04, 1 + n[0] * m[0] + n[1] * m[1])
        result.append((x + (n[0] + m[0]) * distance, y + (n[1] + m[1]) * distance))
    return result


def rectangle(x, y, w, h, radius=0, steps=6):
    """Rounded rectangle in the existing game's top-left stage coordinates."""
    points = []
    if not radius:
        points = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    else:
        for cx, cy, start in ((x + radius, y + radius, 180), (x + w - radius, y + radius, 270),
                              (x + w - radius, y + h - radius, 0), (x + radius, y + h - radius, 90)):
            for i in range(steps + 1):
                a = math.radians(start + i * 90 / steps)
                points.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return ccw([((x - 530) / 100, (870 - y) / 100) for x, y in points])


def flat(m, points, normal, name):
    normal = tuple(float(value) for value in normal)
    if len(points) <= 4:
        m.face(points, [normal] * len(points), name)
        return
    # Concave enamel caps need explicit ears; a fan can reverse triangles in
    # the notch of the seven. Keep each exported triangle facing its normal.
    points = list(points)
    area = sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(points, points[1:] + points[:1]))
    if area < 0:
        points.reverse()
    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    while len(points) > 3:
        for i, b in enumerate(points):
            a, c = points[i - 1], points[(i + 1) % len(points)]
            if abs(cross(a, b, c)) < 1e-10:
                points.pop(i)
                break
            if cross(a, b, c) <= 0:
                continue
            others = [p for j, p in enumerate(points) if j not in ((i - 1) % len(points), i, (i + 1) % len(points))]
            if any(cross(a, b, p) >= -1e-10 and cross(b, c, p) >= -1e-10 and cross(c, a, p) >= -1e-10 for p in others):
                continue
            m.face([a, b, c], [normal] * 3, name)
            points.pop(i)
            break
        else:
            raise ValueError('The cap outline must be a simple polygon.')
    m.face(points, [normal] * len(points), name)


def walls(m, back, front, name, inward=False):
    for i in range(len(back)):
        j = (i + 1) % len(back)
        points = [back[i], back[j], front[j], front[i]]
        a, b, c = (hou.Vector3(p) for p in points[:3])
        normal = (b - a).cross(c - a).normalized()
        if inward:
            normal *= -1
        flat(m, points, tuple(normal), name)


def solid(m, path, back, front, bevel, name):
    path = ccw(path)
    inner = inset(path, bevel)
    contours = [[(x, y, z) for x, y in shape] for shape, z in
                ((path, back), (path, front - bevel), (inner, front))]
    flat(m, contours[0], (0, 0, -1), name)
    flat(m, contours[-1], (0, 0, 1), name)
    for a, b in zip(contours, contours[1:]):
        walls(m, a, b, name)


def frame(m, outer, inner, back, front, bevel, name):
    assert len(outer) == len(inner)
    outer_face, inner_face = inset(outer, bevel), inset(inner, -bevel)
    for shape0, shape1, z0, z1, inward in (
        (outer, outer, back, front - bevel, False),
        (outer, outer_face, front - bevel, front, False),
        (inner, inner, back, front - bevel, True),
        (inner, inner_face, front - bevel, front, True),
    ):
        walls(m, [(x, y, z0) for x, y in shape0], [(x, y, z1) for x, y in shape1], name, inward)
    for a, b, z, direction in ((outer_face, inner_face, front, 1), (outer, inner, back, -1)):
        for i in range(len(a)):
            j = (i + 1) % len(a)
            flat(m, [(a[i][0], a[i][1], z), (a[j][0], a[j][1], z),
                     (b[j][0], b[j][1], z), (b[i][0], b[i][1], z)], (0, 0, direction), name)


def ellipse(x, y, rx, ry, count=48):
    return ccw([((x - 530 + rx * math.cos(i * math.tau / count)) / 100,
                 (870 - y + ry * math.sin(i * math.tau / count)) / 100) for i in range(count)])


def contour_normals(path):
    result = []
    for i, (x, y) in enumerate(path):
        px, py = path[i - 1]
        qx, qy = path[(i + 1) % len(path)]
        a, b = math.hypot(x - px, y - py), math.hypot(qx - x, qy - y)
        result.append(hou.Vector3(((y - py) / a + (qy - y) / b,
                                  -(x - px) / a - (qx - x) / b, 0)).normalized())
    return result


def rounded_solid(m, path, back, front, radius, name, steps=3):
    """A continuous round-over on both ends, with explicit smooth normals."""
    path = ccw(path)
    radius = min(radius, (front - back) * .49)
    normals = contour_normals(path)
    profile = []
    for i in range(steps + 1):
        a = i * math.pi / (2 * steps)
        profile.append((radius * (1 - math.sin(a)), back + radius * (1 - math.cos(a)), math.sin(a), -math.cos(a)))
    for i in range(steps + 1):
        a = i * math.pi / (2 * steps)
        profile.append((radius * (1 - math.cos(a)), front - radius + radius * math.sin(a), math.cos(a), math.sin(a)))
    rings, directions = [], []
    for amount, z, side, nz in profile:
        rings.append([(x, y, z) for x, y in inset(path, amount)])
        directions.append([(float(n[0] * side), float(n[1] * side), float(nz)) for n in normals])
    flat(m, rings[0], (0, 0, -1), name)
    flat(m, rings[-1], (0, 0, 1), name)
    for row in range(len(rings) - 1):
        for i in range(len(path)):
            j = (i + 1) % len(path)
            m.face([rings[row][i], rings[row][j], rings[row + 1][j], rings[row + 1][i]],
                   [directions[row][i], directions[row][j], directions[row + 1][j], directions[row + 1][i]], name)


def moulding(m, path, z, width, depth, name='cabinet_gold', segments=8):
    """Elliptical rolled brass section, following a closed outline."""
    path = ccw(path)
    directions = contour_normals(path)
    def vertex(i, a):
        nx, ny = directions[i][0], directions[i][1]
        x, y = path[i]
        normal = hou.Vector3((nx * math.cos(a) / width, ny * math.cos(a) / width, math.sin(a) / depth)).normalized()
        return (x + nx * width * math.cos(a), y + ny * width * math.cos(a), z + depth * math.sin(a)), tuple(normal)
    for i in range(len(path)):
        j = (i + 1) % len(path)
        for k in range(segments):
            a, b = k * math.tau / segments, (k + 1) * math.tau / segments
            points, normals = zip(vertex(i, a), vertex(j, a), vertex(j, b), vertex(i, b))
            m.face(points, normals, name)


def loft_shell(m, sections, name, close_front=False):
    """Tapered body with smooth shoulders; the reel cavity remains open."""
    rings = [[hou.Vector3((x, y, z)) for x, y in path] for path, z in sections]
    normals = []
    count = len(rings[0])
    for row, ring in enumerate(rings):
        values = []
        for i in range(count):
            along = ring[(i + 1) % count] - ring[i - 1]
            depth = rings[min(len(rings) - 1, row + 1)][i] - rings[max(0, row - 1)][i]
            values.append(tuple(along.cross(depth).normalized()))
        normals.append(values)
    flat(m, [tuple(p) for p in rings[0]], (0, 0, -1), name)
    if close_front:
        flat(m, [tuple(p) for p in rings[-1]], (0, 0, 1), name)
    for row in range(len(rings) - 1):
        for i in range(count):
            j = (i + 1) % count
            m.face([tuple(rings[row][i]), tuple(rings[row][j]), tuple(rings[row + 1][j]), tuple(rings[row + 1][i])],
                   [normals[row][i], normals[row][j], normals[row + 1][j], normals[row + 1][i]], name)


def rounded_outline(path, distance=.2, steps=6):
    points = []
    for i, point in enumerate(path):
        p, a, b = hou.Vector2(point), hou.Vector2(path[i - 1]), hou.Vector2(path[(i + 1) % len(path)])
        cut = min(distance, (a - p).length() * .3, (b - p).length() * .3)
        start, end = p + (a - p).normalized() * cut, p + (b - p).normalized() * cut
        for j in range(steps + 1):
            t = j / steps
            q = start * (1 - t) ** 2 + p * 2 * t * (1 - t) + end * t ** 2
            points.append(tuple(q))
    return ccw(points)


class SidePanel:
    """Place planar trim onto the cabinet's gently tapered side."""
    def __init__(self, model, side):
        self.model, self.side = model, side

    def face(self, positions, normals, name):
        points = [(self.side * (3.50 + .095 * (u - 1.8) + depth), y, u - 2.0) for u, y, depth in positions]
        directions = [tuple(hou.Vector3((self.side * nz, ny, nx - .095 * nz)).normalized()) for nx, ny, nz in normals]
        self.model.face(points, directions, name)


def build_seven(geo):
    m = Model(geo)
    # Draw the glyph itself: a waved flag, bowed stem and flared serif.
    current = (-.74, .98)
    outline = [current]
    curves = [((-.26, 1.02), (.22, .90), (.69, 1.03), 14),
              ((.90, 1.11), (1.02, .90), (.87, .69), 10),
              ((.47, .19), (.13, -.23), (.07, -.80), 18),
              ((.05, -.94), (-.17, -1.01), (-.43, -.98), 10),
              ((-.63, -.98), (-.68, -.91), (-.61, -.73), 10),
              ((-.42, -.10), (-.17, .34), (.24, .62), 18),
              ((-.13, .55), (-.41, .75), (-.64, .60), 14),
              ((-.86, .49), (-1.04, .66), (-.96, .84), 12),
              ((-.92, .97), (-.85, .99), (-.74, .98), 10)]
    for a, b, end, steps in curves:
        for i in range(1, steps + 1):
            t = i / steps
            outline.append(tuple(current[k] * (1 - t) ** 3 + a[k] * 3 * t * (1 - t) ** 2 + b[k] * 3 * t * t * (1 - t) + end[k] * t ** 3 for k in range(2)))
        current = end
    outline = ccw(outline[:-1])
    rounded_solid(m, outline, -.13, .15, .036, 'seven_gold', steps=5)
    solid(m, inset(outline, .054), .137, .184, .009, 'seven_border')
    rounded_solid(m, inset(outline, .070), .175, .245, .024, 'seven_enamel', steps=5)


def build_cabinet(geo):
    m = Model(geo)
    # The shoulders taper toward the rear instead of extruding a flat box.
    loft_shell(m, [(rectangle(216, 174, 624, 641, 56), -3.58),
                   (rectangle(210, 168, 636, 653, 54), -3.46),
                   (rectangle(196, 155, 664, 671, 49), -2.45),
                   (rectangle(184, 150, 688, 682, 48), -.72),
                   (rectangle(183, 154, 690, 679, 48), -.20)], 'cabinet_body')
    rounded_solid(m, rectangle(230, 191, 596, 605, 36), -3.635, -3.575, .025, 'cabinet_back')
    moulding(m, rectangle(229, 190, 598, 607, 36), -3.63, .012, .014, 'cabinet_shadow')
    for y in range(269, 425, 17):
        rounded_solid(m, rectangle(388, y, 280, 6, 3, 3), -3.655, -3.630, .008, 'cabinet_vent', steps=2)
    for x in (-2.68, 2.63):
        for y in (1.03, 6.35):
            m.sphere((x, y, -3.653), (.04, .04, .018), 'cabinet_shadow', segments=10, rows=6)
    # Inlaid side panels carry a restrained fan motif in actual brass geometry.
    panel_path = ccw([(-1.10, 1.15), (1.10, 1.15), (1.10, 6.16), (.85, 6.48), (-.85, 6.48), (-1.10, 6.16)])
    panel_path = rounded_outline(panel_path, .22)
    for side in (-1, 1):
        panel = SidePanel(m, side)
        rounded_solid(panel, panel_path, .02, .075, .025, 'cabinet_lacquer', steps=3)
        moulding(panel, inset(panel_path, .055), .087, .023, .012, 'cabinet_gold', segments=6)
        moulding(panel, inset(panel_path, .12), .085, .007, .007, 'cabinet_engraving', segments=6)
        for i in range(-3, 4):
            x = i * .24
            fan = ccw([(x * .10 - .008, 2.18), (x - .008, 5.73 - abs(i) * .12),
                       (x + .008, 5.73 - abs(i) * .12), (x * .10 + .008, 2.18)])
            solid(panel, fan, .077, .087, .002, 'cabinet_engraving')
        diamond = ccw([(0, 1.57), (.17, 1.90), (0, 2.25), (-.17, 1.90)])
        rounded_solid(panel, diamond, .075, .11, .008, 'cabinet_gold', steps=2)
    # Rolled, round brass edges catch a continuous highlight around the window.
    outer = rectangle(183, 155, 692, 497, 40)
    window = rectangle(248, 239, 561, 326, 11)
    frame(m, outer, window, -.20, .27, .035, 'cabinet_lacquer')
    frame(m, outer, rectangle(198, 170, 662, 467, 28), .20, .36, .025, 'cabinet_shadow')
    moulding(m, rectangle(191, 163, 676, 481, 35), .35, .074, .070)
    moulding(m, rectangle(204, 176, 650, 455, 27), .33, .016, .020, 'cabinet_highlight')
    frame(m, rectangle(233, 226, 591, 352, 19), window, .22, .40, .02, 'cabinet_shadow')
    moulding(m, rectangle(239, 232, 579, 340, 15), .43, .056, .054)
    moulding(m, rectangle(246, 238, 563, 328, 11), .40, .015, .018, 'cabinet_highlight')
    rounded_solid(m, rectangle(254, 175, 550, 47, 12), .26, .31, .018, 'cabinet_black', steps=3)
    moulding(m, rectangle(252, 173, 554, 51, 12), .33, .016, .017, 'cabinet_highlight')
    # Rounded pilasters with narrow flutes and rings at both ends.
    for x in (208, 847):
        rounded_solid(m, rectangle(x - 12, 254, 24, 319, 12), .29, .64, .09, 'cabinet_gold')
        for dx in (-6, 0, 6):
            rounded_solid(m, rectangle(x + dx - 1, 275, 2, 277, 1, 2), .637, .641, .0015, 'cabinet_shadow', steps=2)
        for y in (244, 253, 566, 576):
            rounded_solid(m, rectangle(x - 18, y, 36, 10, 5), .27, .65, .045, 'cabinet_gold', steps=3)
    rounded_solid(m, rectangle(176, 600, 708, 30, 14), -.10, .60, .13, 'cabinet_gold')
    rounded_solid(m, rectangle(210, 604, 640, 19, 8), .59, .61, .007, 'cabinet_engraving', steps=2)
    deck = ccw([((x - 530) / 100, (870 - y) / 100) for x, y in
                ((159, 641), (884, 641), (937, 695), (934, 832), (892, 856),
                 (126, 856), (90, 829), (101, 706))])
    deck = rounded_outline(deck, .28)
    rear_deck = [(x * .95, (y - 1.2) * .85 + 1.2) for x, y in deck]
    shoulder = [(x * .975, (y - 1.2) * .92 + 1.2) for x, y in deck]
    loft_shell(m, [(rear_deck, -3.58), (shoulder, -3.46),
                   (deck, -.08), (deck, .44), (inset(deck, .045), .66)], 'cabinet_body', close_front=True)
    rounded_solid(m, inset(deck, .04), .60, .78, .065, 'cabinet_gold', steps=3)
    rounded_solid(m, inset(deck, .15), .73, .81, .035, 'cabinet_lacquer', steps=3)
    moulding(m, inset(deck, .11), .81, .022, .027, 'cabinet_highlight', segments=6)
    for x, y, w, h in ((112, 706, 213, 84), (645, 703, 264, 91)):
        rounded_solid(m, rectangle(x, y, w, h, 16), .78, .86, .035, 'cabinet_gold', steps=3)
        rounded_solid(m, rectangle(x + 7, y + 7, w - 14, h - 14, 11), .85, .88, .011, 'cabinet_black', steps=3)
        moulding(m, rectangle(x + 2, y + 2, w - 4, h - 4, 14), .86, .017, .018, 'cabinet_highlight', segments=6)
    rounded_solid(m, ellipse(487, 738, 151, 76, 64), .75, .91, .07, 'cabinet_shadow')
    rounded_solid(m, ellipse(487, 738, 144, 69, 64), .86, 1.08, .085, 'cabinet_gold')
    moulding(m, ellipse(487, 738, 132, 58, 64), 1.04, .026, .028, 'cabinet_highlight')
    rounded_solid(m, ellipse(487, 738, 125, 53, 64), 1.025, 1.14, .045, 'cabinet_black', steps=3)
    rounded_solid(m, ellipse(487, 738, 120, 48, 64), 1.09, 1.255, .08, 'cabinet_spin_button', steps=6)
    rounded_solid(m, rectangle(115, 849, 806, 31, 14), -3.58, .81, .12, 'cabinet_gold')
    moulding(m, rectangle(123, 854, 790, 21, 10), .80, .018, .024, 'cabinet_highlight', segments=6)
    for x in (151, 794):
        rounded_solid(m, rectangle(x, 874, 97, 17, 7), -3.42, .48, .055, 'cabinet_black', steps=3)
    # Fine fan engraving in the apron and a split line above the control deck.
    for x in (246, 799):
        for i in range(-3, 4):
            path = ccw([((x + i * 4 - 530) / 100, (870 - 661) / 100),
                        ((x + i * 9 + 1 - 530) / 100, (870 - 688) / 100),
                        ((x + i * 9 - 1 - 530) / 100, (870 - 688) / 100),
                        ((x + i * 4 - 1 - 530) / 100, (870 - 661) / 100)])
            solid(m, path, .812, .822, .002, 'cabinet_engraving')
    for y in (650, 835):
        rounded_solid(m, rectangle(317, y, 343, 2, 1, 2), .812, .819, .002, 'cabinet_engraving', steps=2)
    # A small gilded fan above the switch is made from swept round wires.
    for side in (-1, 1):
        for i in range(4):
            points = [(487 + side * 7, 678, .833), (487 + side * (28 + i * 13), 663 - i * 3, .836),
                      (487 + side * (55 + i * 15), 656 - i * 3, .836), (487 + side * (73 + i * 13), 675, .833)]
            m.stem([((x - 530) / 100, (870 - y) / 100, z) for x, y, z in points], .010, 'cabinet_engraving', steps=10)
    rounded_solid(m, ccw([(-.43, 1.87), (-.35, 1.99), (-.43, 2.11), (-.51, 1.99)]), .818, .848, .006, 'cabinet_gold', steps=2)
    for x, y, z in ((217, 187, .46), (841, 187, .46), (217, 617, .46), (841, 617, .46),
                    (129, 723, .90), (307, 723, .90), (129, 774, .90), (307, 774, .90),
                    (661, 720, .90), (892, 720, .90), (661, 778, .90), (892, 778, .90)):
        m.sphere(((x - 530) / 100, (870 - y) / 100, z), (.038, .038, .016), 'cabinet_gold', segments=12, rows=6)
        rounded_solid(m, rectangle(x - 2, y - .4, 4, .8, .3, 2), z + .014, z + .017, .001, 'cabinet_shadow', steps=2)
    m.sphere((3.46, 3.33, -.24), (.25, .25, .25), 'cabinet_gold', segments=24, rows=14)
    m.stem([(3.48, 3.33, -.24), (3.93, 3.37, -.16), (3.78, 4.12, -.12),
            (3.80, 4.54, -.08)], .065, 'cabinet_chrome', steps=20)
    m.sphere((3.80, 4.57, -.08), (.23, .28, .23), 'cabinet_button', segments=32, rows=20)
    m.torus((3.80, 4.34, -.08), .105, .018, 'cabinet_gold', segments=24)
    # Optional blank drums are retained in the source model, omitted by the game.
    for index, (left, width) in enumerate(((258, 178), (447, 178), (639, 156))):
        x0, x1 = (left - 530) / 100, (left + width - 530) / 100
        cy, cz, radius = (870 - 402.5) / 100, -1.52, 1.77
        for i in range(48):
            a, b = i * math.tau / 48, (i + 1) * math.tau / 48
            points = [(x, cy + math.sin(t) * radius, cz + math.cos(t) * radius)
                      for x, t in ((x0, a), (x1, a), (x1, b), (x0, b))]
            normals = [(0, math.sin(t), math.cos(t)) for t in (a, a, b, b)]
            m.face(points, normals, 'cabinet_reel_' + str(index))


def main():
    from obj_export import compact_obj

    root = Path(__file__).resolve().parents[2]
    local, exports = root / '.art-build', root / 'art-source/houdini/exports'
    local.mkdir(exist_ok=True)
    exports.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).read_text(encoding='utf-8')
    library = Path(__file__).with_name('build_symbols.py').read_text(encoding='utf-8')
    embedded = library[:library.index('\ndef main():')] + '\n' + source[:source.index('\ndef main():')].replace('from build_symbols import Model', '')
    report = []
    for kind in ('seven', 'cabinet'):
        parent = hou.node('/obj')
        if parent.node('slot_chan_' + kind):
            raise RuntimeError('Run in a fresh Houdini session.')
        container = parent.createNode('geo', 'slot_chan_' + kind, run_init_scripts=False)
        generator = container.createNode('python', 'procedural_' + kind)
        generator.parm('python').set(embedded + '\nbuild_' + kind + '(hou.pwd().geometry())\n')
        triangles = container.createNode('divide', 'triangulate_for_web')
        triangles.setInput(0, generator)
        output = container.createNode('null', 'OUT_' + kind.upper())
        output.setInput(0, triangles)
        output.setDisplayFlag(True)
        output.setRenderFlag(True)
        container.layoutChildren()
        try:
            output.cook(force=True)
        except hou.OperationFailed:
            pass  # Report the Python SOP's precise error below.
        errors = generator.errors() + triangles.errors() + output.errors()
        if errors:
            raise RuntimeError('\n'.join(errors))
        geometry = output.geometry()
        asset = exports / ('slot-chan-' + kind + '.obj')
        geometry.saveToFile(str(asset))
        compact_obj(asset)
        report.append({'model': kind, 'triangles': len(geometry.prims()), 'bytes': asset.stat().st_size})
    hou.node('/obj').layoutChildren()
    hou.hipFile.save(str(local / 'slot-chan-cabinet.hipnc'), save_to_recent_files=False)
    print(json.dumps({'houdini': hou.applicationVersionString(), 'models': report, 'scene': '.art-build/slot-chan-cabinet.hipnc'}))


if __name__ == '__main__':
    main()
