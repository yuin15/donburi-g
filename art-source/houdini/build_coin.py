"""Build Slot-chan's coin inside Houdini and export non-commercial OBJ geometry.

Run with Houdini's hython. The editable scene is generated locally; only the
script and the exported asset belong in Git. No account or license data is read.
"""

from pathlib import Path
import json
import math
import hou


def build_geometry(geo, segments=64, reeds=48):
    """Create a beveled coin, milled edge, and raised sevens on both faces."""
    geo.clear()
    normal = geo.addAttrib(hou.attribType.Point, "N", (0.0, 0.0, 1.0))
    groups = {name: geo.createPrimGroup(name) for name in (
        "coin_body", "coin_rim", "coin_reeds", "coin_seven",
    )}

    def face(vertices, normals, group):
        polygon = geo.createPolygon()
        # Houdini's OBJ exporter reverses polygon order. Keep exported faces
        # aligned with the outward normals for Three.js front-face culling.
        for position, direction in reversed(list(zip(vertices, normals))):
            point = geo.createPoint()
            point.setPosition(position)
            point.setAttribValue(normal, direction)
            polygon.addVertex(point)
        groups[group].add(polygon)

    def lathe(profile, group):
        for (r0, z0), (r1, z1) in zip(profile, profile[1:]):
            length = math.hypot(r1 - r0, z1 - z0)
            radial, nz = (z1 - z0) / length, -(r1 - r0) / length
            for i in range(segments):
                a, b = 2 * math.pi * i / segments, 2 * math.pi * (i + 1) / segments
                positions = [(r0 * math.cos(a), r0 * math.sin(a), z0),
                             (r0 * math.cos(b), r0 * math.sin(b), z0),
                             (r1 * math.cos(b), r1 * math.sin(b), z1),
                             (r1 * math.cos(a), r1 * math.sin(a), z1)]
                normals = [(radial * math.cos(t), radial * math.sin(t), nz) for t in (a, b, b, a)]
                if r0 == 0:
                    face([positions[j] for j in (0, 2, 3)], [normals[j] for j in (0, 2, 3)], group)
                elif r1 == 0:
                    face(positions[:3], normals[:3], group)
                else:
                    face(positions, normals, group)

    # One connected body; the thin chamfers catch moving light during a spin.
    lathe([(0, -.08), (.91, -.08), (.98, -.08), (1, -.058),
           (1, .058), (.98, .08), (.91, .08), (0, .08)], "coin_body")
    for side in (-1, 1):
        ring = [(.80, .081), (.83, .107), (.89, .107), (.915, .083)]
        lip = [(.945, .081), (.964, .108), (.976, .108), (.994, .068)]
        for profile in (ring, lip):
            # Lathe profile direction determines the outward surface normal.
            lathe([(r, z * side) for r, z in (profile if side < 0 else reversed(profile))], "coin_rim")

    for i in range(reeds):
        angle = 2 * math.pi * i / reeds
        a, b = angle - .014, angle + .014
        points = [(r * math.cos(t), r * math.sin(t), z)
                  for z in (-.05, .05) for r, t in ((.996, a), (1.011, a), (1.011, b), (.996, b))]
        for ids in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                    (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            vertices = [points[j] for j in ids]
            p, q, r = (hou.Vector3(v) for v in vertices[:3])
            direction = tuple((q - p).cross(r - p).normalized())
            face(vertices, [direction] * 4, "coin_reeds")

    # Two convex pieces form a generous, legible 7. The overlap stays inside
    # the relief, avoiding a dependency on installed fonts or font licensing.
    pieces = [ [(-.39, .45), (-.39, .25), (.35, .25), (.39, .45)],
               [(.105, .29), (-.30, -.46), (-.035, -.46), (.365, .29)] ]
    for side in (-1, 1):
        for outline in pieces:
            contour = [(x * side, y) for x, y in outline]
            signed_area = sum(x * contour[(i + 1) % len(contour)][1]
                              - y * contour[(i + 1) % len(contour)][0]
                              for i, (x, y) in enumerate(contour))
            if signed_area * side < 0:
                contour.reverse()
            back = [(x, y, .078 * side) for x, y in contour]
            front = [(x, y, .143 * side) for x, y in contour]
            face(front, [(0.0, 0.0, float(side))] * len(front), "coin_seven")
            face(list(reversed(back)), [(0.0, 0.0, float(-side))] * len(back), "coin_seven")
            for i in range(len(contour)):
                j = (i + 1) % len(contour)
                vertices = [back[i], back[j], front[j], front[i]]
                p, q, r = (hou.Vector3(v) for v in vertices[:3])
                direction = tuple((q - p).cross(r - p).normalized())
                face(vertices, [direction] * 4, "coin_seven")


def main():
    root = Path(__file__).resolve().parents[2]
    local = root / ".art-build"
    exported = root / "art-source" / "houdini" / "exports"
    local.mkdir(exist_ok=True)
    exported.mkdir(parents=True, exist_ok=True)

    obj = hou.node("/obj")
    existing = obj.node("slot_chan_coin")
    if existing is not None:
        raise RuntimeError("slot_chan_coin already exists. Run in a fresh Houdini session.")
    container = obj.createNode("geo", "slot_chan_coin", run_init_scripts=False)
    generator = container.createNode("python", "procedural_coin")
    parameter_group = generator.parmTemplateGroup()
    parameter_group.append(hou.IntParmTemplate("segments", "Round segments", 1, default_value=(64,), min=24, max=96))
    parameter_group.append(hou.IntParmTemplate("reeds", "Edge grooves", 1, default_value=(48,), min=0, max=64))
    generator.setParmTemplateGroup(parameter_group)

    # Embed the generator itself so the local .hipnc remains editable without
    # depending on any developer-specific filesystem path.
    source = Path(__file__).read_text(encoding="utf-8")
    embedded = source[:source.index("\ndef main():")]
    generator.parm("python").set(embedded + "\nnode = hou.pwd()\nbuild_geometry(node.geometry(), node.evalParm('segments'), node.evalParm('reeds'))\n")
    output = container.createNode("null", "OUT_COIN")
    output.setInput(0, generator)
    output.setDisplayFlag(True)
    output.setRenderFlag(True)
    container.layoutChildren()
    geometry = output.geometry()
    geometry.saveToFile(str(exported / "slot-chan-coin.obj"))
    hou.hipFile.save(str(local / "slot-chan-coin.hipnc"), save_to_recent_files=False)
    print(json.dumps({"houdini": hou.applicationVersionString(),
                      "points": len(geometry.points()), "polygons": len(geometry.prims()),
                      "asset": "art-source/houdini/exports/slot-chan-coin.obj",
                      "scene": ".art-build/slot-chan-coin.hipnc"}))


if __name__ == "__main__":
    main()
