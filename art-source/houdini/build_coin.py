"""Build Slot-chan's coin inside Houdini and export non-commercial OBJ geometry.

Run with Houdini's hython. The editable scene is generated locally; only the
script and the exported asset belong in Git. No account or license data is read.
"""

from pathlib import Path
import json
import math
import hou
from build_cabinet import make_seven
from build_symbols import Model


def build_geometry(geo, segments=64, reeds=48):
    """Create a beveled coin, milled edge, and raised sevens on both faces."""
    geo.clear()
    normal = geo.addAttrib(hou.attribType.Point, "N", (0.0, 0.0, 1.0))
    groups = {name: geo.createPrimGroup(name) for name in (
        "coin_body", "coin_rim", "coin_reeds", "coin_seven",
    )}

    def face(vertices, normals, group):
        if group not in groups:
            groups[group] = geo.createPrimGroup(group)
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

    class CoinSurface(Model):
        cap_depth = 1
        def __init__(self, side): self.side=side
        def face(self, positions, normals, name):
            p=[(x*.67*self.side,y*.67,(z*.30+.16)*self.side) for x,y,z in positions]
            n=[tuple(hou.Vector3((nx*self.side,ny,nz*self.side*.67/.30)).normalized()) for nx,ny,nz in normals]
            face(p,n,'coin_'+name)
    for side in (-1,1):
        make_seven(CoinSurface(side))
        # Radial sunburst engraving and a beaded inner rim on both faces.
        for i in range(48):
            a=i*math.tau/48
            p=[(r*math.cos(a+da),r*math.sin(a+da),z*side)
               for r,da,z in ((.19,-.006,.082),(.77,-.006,.082),(.77,.006,.098),(.19,.006,.098))]
            face(p,[(0,0,float(side))]*4,'coin_rim')
            cx,cy=.858*math.cos(a),.858*math.sin(a)
            # Low-resolution domes are intentional: the token is 30–70 px in game.
            for j in range(8):
                u,v=j*math.tau/8,(j+1)*math.tau/8
                p=[(cx,cy,.136*side),(cx+math.cos(u)*.019,cy+math.sin(u)*.019,.108*side),
                   (cx+math.cos(v)*.019,cy+math.sin(v)*.019,.108*side)]
                face(p,[(0,0,float(side))]*3,'coin_rim')


def main():
    from obj_export import compact_obj

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
    cabinet = Path(__file__).with_name('build_cabinet.py').read_text(encoding='utf-8')
    symbols = Path(__file__).with_name('build_symbols.py').read_text(encoding='utf-8')
    embedded = symbols[:symbols.index('\ndef main():')] + '\n' + cabinet[:cabinet.index('\ndef main():')].replace('from build_symbols import Model','') + '\n' + source[:source.index('\ndef main():')].replace('from build_cabinet import make_seven','').replace('from build_symbols import Model','')
    generator.parm("python").set(embedded + "\nnode = hou.pwd()\nbuild_geometry(node.geometry(), node.evalParm('segments'), node.evalParm('reeds'))\n")
    triangles = container.createNode("divide", "triangulate_for_web")
    triangles.setInput(0, generator)
    output = container.createNode("null", "OUT_COIN")
    output.setInput(0, triangles)
    output.setDisplayFlag(True)
    output.setRenderFlag(True)
    container.layoutChildren()
    geometry = output.geometry()
    asset = exported / "slot-chan-coin.obj"
    geometry.saveToFile(str(asset))
    # Weld only identical exported values; keep sharp normals and native precision.
    compact_obj(asset)
    hou.hipFile.save(str(local / "slot-chan-coin.hipnc"), save_to_recent_files=False)
    print(json.dumps({"houdini": hou.applicationVersionString(),
                      "points": len(geometry.points()), "polygons": len(geometry.prims()),
                      "asset": "art-source/houdini/exports/slot-chan-coin.obj",
                      "scene": ".art-build/slot-chan-coin.hipnc"}))


if __name__ == "__main__":
    main()
