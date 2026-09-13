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
        def position_at(u, v):
            a, b = u * math.tau, v * math.pi
            radial = math.sin(b)
            # Broad heart-shaped shoulders, a real stem well and a tapered base.
            dimple = .34 * math.exp(-(b / .36) ** 2) if cherry else 0
            shape = 1 + (.15 * math.cos(b) + .045 * math.cos(2 * a) * radial if cherry else 0)
            x, y, z = radial * math.cos(a) * shape, math.cos(b) - dimple, radial * math.sin(a) * shape
            return hou.Vector3((center[0] + radius[0] * x, center[1] + radius[1] * y, center[2] + radius[2] * z))
        def surface(u, v):
            p = position_at(u, v)
            a = position_at(u + .0002, max(.0001, min(.9999, v))) - position_at(u - .0002, max(.0001, min(.9999, v)))
            b = position_at(u, min(.9999, v + .0002)) - position_at(u, max(.0001, v - .0002))
            normal = a.cross(b).normalized()
            return tuple(p), tuple(normal)
        self.grid(surface, segments, rows, name)

    def tube(self, points, radius, name, sides=8):
        """Smooth tube along a sampled curve; also used for raised leaf edging."""
        rings = []
        points = [hou.Vector3(p) for p in points]
        for i, p in enumerate(points):
            tangent = (points[min(i + 1, len(points) - 1)] - points[max(0, i - 1)]).normalized()
            axis = tangent.cross(hou.Vector3((0, 0, 1))).normalized()
            if axis.length() < .1:
                axis = tangent.cross(hou.Vector3((0, 1, 0))).normalized()
            other = tangent.cross(axis).normalized()
            rings.append([(p + (axis * math.cos(j * math.tau / sides) + other * math.sin(j * math.tau / sides)) * radius,
                           axis * math.cos(j * math.tau / sides) + other * math.sin(j * math.tau / sides)) for j in range(sides)])
        for a, b in zip(rings, rings[1:]):
            for j in range(sides):
                k = (j + 1) % sides
                values = [a[j], a[k], b[k], b[j]]
                self.face([tuple(p) for p, n in values], [tuple(n) for p, n in values], name)

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
    # Taller shoulder and a restrained rolled lip: a bell, not a wide hat.
    m.lathe([(.72, -.64), (.79, -.62), (.815, -.57), (.802, -.51), (.77, -.47),
             (.69, -.38), (.61, -.21), (.55, .03), (.52, .30), (.49, .47),
             (.43, .60), (.34, .69), (.20, .75), (0, .78)], "bell_gold", segments=64)
    m.lathe([(.72, -.64), (.70, -.52), (.62, -.39), (.53, -.20), (.43, .29), (.34, .48), (0, .64)], "bell_inner", segments=64, inside=True)
    for radius, y, tube, material in ((.78,-.59,.035,'bell_trim'),(.73,-.44,.022,'bell_trim'),(.66,-.33,.018,'bell_ridge'),
                                      (.504,.40,.025,'bell_trim'),(.487,.465,.022,'bell_trim'),(.466,.51,.009,'bell_ridge')):
        m.torus((0,y,0),radius,tube,material,segments=56)
    m.sphere((0, .78, 0), (.14, .08, .13), "bell_trim", segments=24, rows=10)
    m.torus((0, .87, 0), .135, .050, "bell_trim", vertical=True, segments=40)
    m.stem([(0, .3, 0), (0, .1, 0), (0, -.3, 0), (0, -.59, 0)], .033, "bell_inner", steps=4)
    m.sphere((0, -.66, .28), (.18, .19, .18), "bell_trim", segments=32, rows=20)
    # A raised, faceted star follows the bell's curved front shoulder.
    points = []
    for i in range(10):
        a = math.pi / 2 + i * math.pi / 5
        r = .24 if i % 2 == 0 else .105
        x, y = math.cos(a) * r, .12 + math.sin(a) * r
        points.append((x, y, .543 - .11 * y - x * x * .7))
    center = (0, .12, .64)
    for i, p in enumerate(points):
        q = points[(i + 1) % 10]
        n = tuple((hou.Vector3(p) - hou.Vector3(center)).cross(hou.Vector3(q) - hou.Vector3(center)).normalized())
        m.face([center,p,q],[n]*3,'bell_trim')


def build_cherry(geo):
    m = Model(geo)
    m.sphere((-.39, -.35, -.08), (.51, .61, .48), "cherry_fruit", segments=48, rows=36, cherry=True)
    m.sphere((.35, -.42, .16), (.56, .61, .52), "cherry_fruit", segments=48, rows=36, cherry=True)
    for center in ((-.39,.074,-.08),(.35,.004,.16),(.03,.92,0)):
        m.sphere(center,(.10,.055,.095),'cherry_gold',segments=24,rows=12)
        m.torus(center,.078,.023,'cherry_gold',segments=24)
    m.stem([(-.39, .074, -.08), (-.36, .59, -.035), (-.10, .82, .025), (.03, .94, 0)], .062, "cherry_stem", steps=24)
    m.stem([(.35, .004, .16), (.34, .53, .15), (.18, .79, .035), (.03, .94, 0)], .060, "cherry_stem", steps=24)
    m.stem([(.06, .88, 0), (.09, 1.00, 0), (.15, 1.04, 0), (.20, 1.02, 0)], .033, "cherry_stem", steps=5)
    # The leaf has a folded ridge and a curved pointed silhouette, on both sides.
    def leaf(u, v):
        width = .29 * math.sin(math.pi * u) ** .9
        across = v * 2 - 1
        x = .04 + .91 * u - .07 * math.sin(math.pi * u)
        y = .91 - .53 * u + width * across
        z = .055 + .14 * math.sin(math.pi * u) - .17 * abs(across) * math.sin(math.pi * u)
        return (x, y, z), tuple(hou.Vector3((.15, .16 * (1 if across > 0 else -1), 1)).normalized())
    m.grid(leaf, 24, 6, "cherry_leaf")
    def back(u, v):
        p, n = leaf(u, v)
        return (p[0], p[1], p[2] - .006), tuple(-x for x in n)
    m.grid(back, 24, 6, "cherry_leaf")
    for v in (0,.5,1):
        m.tube([tuple(p + (.01 if k == 2 else 0) for k,p in enumerate(leaf(i / 30,v)[0])) for i in range(31)],.011 if v == .5 else .009,'cherry_gold')
    for u in (.25, .43, .61, .77):
        start, _ = leaf(u, .5)
        for side in (.09, .91):
            end, _ = leaf(min(.98, u + .16), side)
            a = tuple(start[k] + (end[k] - start[k]) * .32 for k in range(3))
            b = tuple(start[k] + (end[k] - start[k]) * .72 for k in range(3))
            m.stem([(start[0], start[1], start[2] + .016), a, b, (end[0],end[1],end[2]+.01)], .008, "cherry_gold", steps=8)


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
