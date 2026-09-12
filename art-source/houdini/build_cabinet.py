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


def rectangle(x, y, w, h, radius=0, steps=4):
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


def build_seven(geo):
    m = Model(geo)
    outline = ccw([(-.88, .98), (.88, .98), (.86, .70), (.39, .02), (.13, -.98),
                   (-.52, -.98), (-.42, -.48), (-.10, .13), (.32, .55), (-.55, .55), (-.75, .43)])
    solid(m, outline, -.16, .19, .05, 'seven_gold')
    solid(m, inset(outline, .092), .175, .255, .025, 'seven_enamel')


def build_cabinet(geo):
    m = Model(geo)
    # Deep lacquer shell. The rear door sits behind the open reel assembly.
    solid(m, rectangle(188, 154, 680, 676, 44), -3.55, -.24, .07, 'cabinet_body')
    solid(m, rectangle(204, 173, 648, 633, 30), -3.61, -3.54, .025, 'cabinet_back')
    # Vented back cover, with individual shallow metallic louvres.
    for y in range(264, 426, 18):
        solid(m, rectangle(388, y, 280, 6, 2, 2), -3.635, -3.608, .005, 'cabinet_vent')
    for x in (-2.8, 2.75):
        for y in (1.0, 6.5):
            m.sphere((x, y, -3.636), (.048, .048, .018), 'cabinet_shadow', segments=10, rows=6)
    # Fine side-panel pinstripes are geometry too, visible when orbiting.
    for x in (-3.425, 3.385):
        for z in (-3.32, -.50):
            m.stem([(x, .85, z), (x, 2.0, z), (x, 5.0, z), (x, 6.58, z)], .015, 'cabinet_gold', steps=3)
    # Replace the photograph's front with an actual opening and layered moulding.
    outer = rectangle(183, 155, 692, 497, 35)
    window = rectangle(248, 239, 561, 326, 9)
    frame(m, outer, window, -.21, .24, .025, 'cabinet_lacquer')
    frame(m, outer, rectangle(197, 169, 664, 469, 26), .20, .40, .035, 'cabinet_gold')
    frame(m, rectangle(201, 173, 656, 461, 23), rectangle(207, 179, 644, 449, 20), .26, .36, .012, 'cabinet_highlight')
    frame(m, rectangle(233, 226, 591, 352, 16), window, .20, .47, .028, 'cabinet_gold')
    frame(m, rectangle(241, 234, 575, 336, 12), window, .42, .49, .010, 'cabinet_highlight')
    # Blank top marquee under the HTML WIN indicator; no product title is added.
    solid(m, rectangle(254, 175, 550, 47, 10), .26, .30, .02, 'cabinet_black')
    frame(m, rectangle(250, 171, 558, 55, 12), rectangle(256, 177, 546, 43, 9), .30, .42, .014, 'cabinet_gold')
    # Tall fluted columns, with bright rounded caps and recessed black channels.
    for x in (204, 839):
        solid(m, rectangle(x - 11, 249, 22, 330, 10), .23, .57, .07, 'cabinet_gold')
        solid(m, rectangle(x - 3, 270, 6, 288, 2), .51, .58, .012, 'cabinet_shadow')
        for y in (239, 580):
            solid(m, rectangle(x - 18, y, 36, 14, 5), .22, .62, .03, 'cabinet_highlight')
    # Moulded sill and flared control deck, solid from front to back.
    solid(m, rectangle(174, 601, 711, 30, 9), -.12, .53, .07, 'cabinet_gold')
    deck = ccw([((x - 530) / 100, (870 - y) / 100) for x, y in
                ((159, 641), (884, 641), (937, 695), (934, 832), (892, 856),
                 (126, 856), (90, 829), (101, 706))])
    solid(m, deck, -3.56, .64, .10, 'cabinet_body')
    solid(m, inset(deck, .055), .63, .72, .025, 'cabinet_gold')
    solid(m, inset(deck, .13), .70, .76, .022, 'cabinet_lacquer')
    # Three control islands match the game's paytable, SPIN and queue controls.
    for x, y, w, h in ((112, 706, 213, 84), (645, 703, 264, 91)):
        solid(m, rectangle(x, y, w, h, 13), .73, .80, .035, 'cabinet_gold')
        solid(m, rectangle(x + 7, y + 7, w - 14, h - 14, 9), .80, .82, .018, 'cabinet_black')
    solid(m, ellipse(487, 738, 151, 76), .71, .88, .048, 'cabinet_shadow')
    solid(m, ellipse(487, 738, 144, 69), .85, 1.02, .04, 'cabinet_gold')
    solid(m, ellipse(487, 738, 131, 58), .98, 1.08, .018, 'cabinet_highlight')
    solid(m, ellipse(487, 738, 122, 51), 1.06, 1.19, .075, 'cabinet_spin_button')
    # Base, feet and decorative fan cuts anchor the machine to the table.
    solid(m, rectangle(115, 849, 806, 31, 10), -3.58, .77, .06, 'cabinet_gold')
    solid(m, rectangle(126, 860, 784, 10, 4), .75, .82, .016, 'cabinet_highlight')
    for x in (151, 794):
        solid(m, rectangle(x, 874, 97, 17, 5), -3.42, .48, .035, 'cabinet_black')
    for x in (237, 807):
        for i in range(5):
            dx = (i - 2) * 8
            solid(m, ccw([((x + dx - 530) / 100, (870 - 670) / 100),
                          ((x + dx + 3 - 530) / 100, (870 - 670) / 100),
                          ((x + dx * 1.6 + 2 - 530) / 100, (870 - 694) / 100),
                          ((x + dx * 1.6 - 530) / 100, (870 - 694) / 100)]), .76, .78, .003, 'cabinet_highlight')
    # Rounded screw heads, not painted dots, on the marquee, rails and deck.
    for x, y, z in ((217, 187, .46), (841, 187, .46), (217, 617, .46), (841, 617, .46),
                    (129, 723, .85), (307, 723, .85), (129, 774, .85), (307, 774, .85),
                    (661, 720, .85), (892, 720, .85), (661, 778, .85), (892, 778, .85)):
        m.sphere(((x - 530) / 100, (870 - y) / 100, z), (.046, .046, .02), 'cabinet_highlight', segments=10, rows=6)
    # Side lever: a spindle, bent polished shaft and ruby handle.
    m.sphere((3.46, 3.33, -.24), (.23, .23, .23), 'cabinet_gold', segments=16, rows=10)
    m.stem([(3.48, 3.33, -.24), (3.93, 3.37, -.16), (3.78, 4.12, -.12),
            (3.80, 4.54, -.08)], .065, 'cabinet_chrome', steps=12)
    m.sphere((3.80, 4.57, -.08), (.22, .27, .22), 'cabinet_button', segments=20, rows=12)
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
