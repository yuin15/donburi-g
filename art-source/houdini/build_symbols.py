"""Generate editable bell/cherry Python SOPs and non-commercial OBJ assets.

Run with Houdini's hython. Geometry and normals come from Houdini; no external
textures, fonts, account information or machine-specific paths are embedded.
"""

from pathlib import Path
import json
import math
import hou


class Model:
    def __init__(self, geo):
        self.geo = geo
        geo.clear()
        self.normal = geo.addAttrib(hou.attribType.Point, "N", (0.0, 0.0, 1.0))
        self.groups = {}

    def face(self, positions, normals, name):
        if name not in self.groups:
            self.groups[name] = self.geo.createPrimGroup(name)
        p, q, r = (hou.Vector3(v) for v in positions[:3])
        direction = (q - p).cross(r - p)
        if direction.length() < 1e-9:
            return
        values = list(zip(positions, normals))
        if direction.dot(hou.Vector3(normals[0])) < 0:
            values.reverse()
        polygon = self.geo.createPolygon()
        # Houdini reverses OBJ face order on export, so reverse it here too.
        for position, normal in reversed(values):
            point = self.geo.createPoint()
            point.setPosition(position)
            point.setAttribValue(self.normal, normal)
            polygon.addVertex(point)
        self.groups[name].add(polygon)

    def grid(self, point_at, u_count, v_count, name):
        for i in range(u_count):
            for j in range(v_count):
                uv = [(i / u_count, j / v_count), ((i + 1) / u_count, j / v_count),
                      ((i + 1) / u_count, (j + 1) / v_count), (i / u_count, (j + 1) / v_count)]
                positions, normals = zip(*(point_at(u, v) for u, v in uv))
                # Sphere poles have two coincident corners; keep the triangle.
                unique = []
                for k, p in enumerate(positions):
                    if not any((hou.Vector3(p) - hou.Vector3(positions[n])).length() < 1e-7 for n in unique):
                        unique.append(k)
                if len(unique) >= 3:
                    self.face([positions[k] for k in unique], [normals[k] for k in unique], name)

    def sphere(self, center, radius, name, segments=32, rows=18, cherry=False):
        def surface(u, v):
            a, b = u * math.tau, v * math.pi
            radial = math.sin(b)
            # The shallow stem dimple and lower cleft give the fruit a silhouette.
            dimple = .12 * math.exp(-(b / .27) ** 2) if cherry else 0
            shape = 1 + (.024 * math.cos(2 * a) * radial if cherry else 0)
            x, y, z = radial * math.cos(a) * shape, math.cos(b) - dimple, radial * math.sin(a)
            position = (center[0] + radius[0] * x, center[1] + radius[1] * y, center[2] + radius[2] * z)
            normal = tuple(hou.Vector3((x / radius[0], math.cos(b) / radius[1], z / radius[2])).normalized())
            return position, normal
        self.grid(surface, segments, rows, name)

    def lathe(self, profile, name, segments=40, inside=False):
        normals = []
        for i in range(len(profile)):
            r0, y0 = profile[max(0, i - 1)]
            r1, y1 = profile[min(len(profile) - 1, i + 1)]
            n = hou.Vector3((y1 - y0, -(r1 - r0), 0)).normalized()
            normals.append(n * (-1 if inside else 1))
        for j, ((r0, y0), (r1, y1)) in enumerate(zip(profile, profile[1:])):
            for i in range(segments):
                a, b = i / segments * math.tau, (i + 1) / segments * math.tau
                positions = [(r * math.cos(t), y, r * math.sin(t)) for r, y, t in
                             ((r0, y0, a), (r0, y0, b), (r1, y1, b), (r1, y1, a))]
                directions = [(normals[k][0] * math.cos(t), normals[k][1], normals[k][0] * math.sin(t))
                              for k, t in ((j, a), (j, b), (j + 1, b), (j + 1, a))]
                ids = (0, 1, 2) if r1 == 0 else (0, 2, 3) if r0 == 0 else (0, 1, 2, 3)
                self.face([positions[k] for k in ids], [directions[k] for k in ids], name)

    def torus(self, center, radius, tube, name, vertical=False, segments=40):
        def surface(u, v):
            a, b = u * math.tau, v * math.tau
            ring = radius + tube * math.cos(b)
            p = [ring * math.cos(a), tube * math.sin(b), ring * math.sin(a)]
            n = [math.cos(b) * math.cos(a), math.sin(b), math.cos(b) * math.sin(a)]
            if vertical:
                p[1], p[2] = p[2], p[1]
                n[1], n[2] = n[2], n[1]
            return tuple(center[k] + p[k] for k in range(3)), tuple(n)
        self.grid(surface, segments, 8, name)

    def stem(self, points, radius, name, steps=16):
        controls = [hou.Vector3(p) for p in points]
        def curve(t):
            return controls[0] * (1 - t) ** 3 + controls[1] * 3 * t * (1 - t) ** 2 + controls[2] * 3 * t * t * (1 - t) + controls[3] * t ** 3
        def surface(u, v):
            p = curve(u)
            tangent = (curve(min(1, u + .001)) - curve(max(0, u - .001))).normalized()
            axis = tangent.cross(hou.Vector3((0, 0, 1))).normalized()
            other = tangent.cross(axis).normalized()
            normal = axis * math.cos(v * math.tau) + other * math.sin(v * math.tau)
            return tuple(p + normal * radius * (1 - u * .25)), tuple(normal)
        self.grid(surface, steps, 8, name)


def build_bell(geo):
    m = Model(geo)
    m.lathe([(.84, -.65), (.90, -.61), (.90, -.565), (.86, -.52), (.78, -.485),
             (.68, -.40), (.58, -.24), (.49, .025), (.45, .29), (.38, .46), (.24, .55), (0, .58)], "bell_gold")
    m.lathe([(.84, -.65), (.80, -.55), (.66, -.43), (.54, -.23), (.41, .27), (.30, .40), (0, .46)], "bell_inner", inside=True)
    m.torus((0, -.565, 0), .873, .028, "bell_trim")
    m.torus((0, .28, 0), .451, .017, "bell_trim")
    m.sphere((0, .586, 0), (.15, .09, .15), "bell_trim", segments=24, rows=8)
    m.torus((0, .735, 0), .095, .031, "bell_trim", vertical=True, segments=24)
    m.stem([(0, .3, 0), (0, .1, 0), (0, -.3, 0), (0, -.59, 0)], .033, "bell_inner", steps=4)
    m.sphere((0, -.59, 0), (.17, .17, .17), "bell_trim", segments=24, rows=12)


def build_cherry(geo):
    m = Model(geo)
    m.sphere((-.40, -.37, -.025), (.48, .46, .43), "cherry_fruit", cherry=True)
    m.sphere((.39, -.46, .16), (.51, .49, .46), "cherry_fruit", cherry=True)
    m.stem([(-.40, .045, -.025), (-.39, .54, -.02), (-.02, .89, 0), (.08, .91, 0)], .039, "cherry_stem")
    m.stem([(.39, -.025, .16), (.45, .43, .12), (.19, .75, .015), (.08, .91, 0)], .039, "cherry_stem")
    m.stem([(.06, .88, 0), (.09, 1.00, 0), (.15, 1.04, 0), (.20, 1.02, 0)], .033, "cherry_stem", steps=5)
    # The leaf has a folded ridge and a curved pointed silhouette, on both sides.
    def leaf(u, v):
        width = .215 * math.sin(math.pi * u) ** .85
        across = v * 2 - 1
        x = .12 + .76 * u - .07 * math.sin(math.pi * u)
        y = .83 - .38 * u + width * across
        z = .035 + .075 * math.sin(math.pi * u) - .14 * abs(across) * math.sin(math.pi * u)
        return (x, y, z), tuple(hou.Vector3((.15, .16 * (1 if across > 0 else -1), 1)).normalized())
    m.grid(leaf, 16, 4, "cherry_leaf")
    def back(u, v):
        p, n = leaf(u, v)
        return (p[0], p[1], p[2] - .006), tuple(-x for x in n)
    m.grid(back, 16, 4, "cherry_leaf")
    m.stem([(.12, .83, .055), (.33, .77, .14), (.58, .60, .13), (.85, .45, .055)], .012, "cherry_vein", steps=14)


def main():
    from obj_export import compact_obj

    root = Path(__file__).resolve().parents[2]
    local, exports = root / ".art-build", root / "art-source" / "houdini" / "exports"
    local.mkdir(exist_ok=True)
    exports.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).read_text(encoding="utf-8")
    embedded = source[:source.index("\ndef main():")]
    report = []
    for kind in ("bell", "cherry"):
        obj = hou.node("/obj")
        if obj.node("slot_chan_" + kind) is not None:
            raise RuntimeError("Run in a fresh Houdini session.")
        container = obj.createNode("geo", "slot_chan_" + kind, run_init_scripts=False)
        generator = container.createNode("python", "procedural_" + kind)
        generator.parm("python").set(embedded + "\nbuild_" + kind + "(hou.pwd().geometry())\n")
        triangles = container.createNode("divide", "triangulate_for_web")
        triangles.setInput(0, generator)
        output = container.createNode("null", "OUT_" + kind.upper())
        output.setInput(0, triangles)
        output.setDisplayFlag(True)
        output.setRenderFlag(True)
        container.layoutChildren()
        geometry = output.geometry()
        asset = exports / ("slot-chan-" + kind + ".obj")
        geometry.saveToFile(str(asset))
        compact_obj(asset)
        report.append({"model": kind, "points": len(geometry.points()), "triangles": len(geometry.prims()), "bytes": asset.stat().st_size})
    hou.node("/obj").layoutChildren()
    hou.hipFile.save(str(local / "slot-chan-symbols.hipnc"), save_to_recent_files=False)
    print(json.dumps({"houdini": hou.applicationVersionString(), "models": report, "scene": ".art-build/slot-chan-symbols.hipnc"}))


if __name__ == "__main__":
    main()
