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


def bezier(points, steps=16):
    p = [hou.Vector3(tuple(value) + (0,) if len(value) == 2 else value) for value in points]
    return [tuple(p[0]*(1-t)**3 + p[1]*3*t*(1-t)**2 + p[2]*3*t*t*(1-t) + p[3]*t**3)
            for t in (i/steps for i in range(steps+1))]


def seven_outline():
    """The approved broad wavy flag and curved, flared diagonal, in real geometry."""
    points = [(-.92,.94),(-.53,.98),(-.51,.86)]
    for controls in [((-.51,.86),(-.07,1.10),(.25,.88),(.90,1.04)),
                     ((.90,1.04),(.89,.89),(.89,.83),(.85,.74)),
                     ((.85,.74),(.55,.33),(.05,-.12),(.08,-1.02))]:
        points.extend([p[:2] for p in bezier(controls,12)[1:]])
    points.append((-.94,-1.02))
    points.extend([p[:2] for p in bezier(((-.94,-1.02),(-.77,-.23),(-.20,.02),(.28,.38)),16)[1:]])
    points.extend([p[:2] for p in bezier(((.28,.38),(-.17,.20),(-.60,.52),(-.74,.18)),14)[1:]])
    points.append((-1.01,.15))
    return ccw(points)


def crowned_cap(m, path, z, height, name):
    """Tessellated enamel surface with an actual convex cushion and smooth normals."""
    edges = list(zip(path,path[1:]+path[:1]))
    def elevation(x,y):
        d = 1e9
        for (ax,ay),(bx,by) in edges:
            dx,dy = bx-ax,by-ay
            t = max(0,min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)))
            d = min(d,math.hypot(x-ax-t*dx,y-ay-t*dy))
        return z + height * (1-math.exp(-d/.075))
    def vertex(p):
        x,y = p[:2]
        dx = (elevation(x+.001,y)-elevation(x-.001,y))/.002
        dy = (elevation(x,y+.001)-elevation(x,y-.001))/.002
        return (x,y,elevation(x,y)),tuple(hou.Vector3((-dx,-dy,1)).normalized())
    class Cap:
        def face(self,positions,normals,group):
            def split(a,b,c,depth):
                if depth == 0:
                    values = [vertex(p) for p in (a,b,c)]
                    m.face([p for p,n in values],[n for p,n in values],group)
                    return
                ab = tuple((x+y)/2 for x,y in zip(a,b)); bc = tuple((x+y)/2 for x,y in zip(b,c)); ca = tuple((x+y)/2 for x,y in zip(c,a))
                for tri in ((a,ab,ca),(ab,b,bc),(ca,bc,c),(ab,bc,ca)):
                    split(*tri,depth-1)
            split(*positions,getattr(m,'cap_depth',3))
    flat(Cap(),[(x,y,z) for x,y in path],(0,0,1),name)


def make_seven(m):
    outline = seven_outline()
    def inner(amount):
        # Offset cusps can form tiny loops at the flag's upstand. Trim those
        # loops before capping, retaining the large connected glyph contour.
        path = []
        for i,(x,y) in enumerate(outline):
            px,py = outline[i-1]; qx,qy = outline[(i+1)%len(outline)]
            ax,ay,bx,by = x-px,y-py,qx-x,qy-y
            al,bl = math.hypot(ax,ay),math.hypot(bx,by)
            n,mn = (-ay/al,ax/al),(-by/bl,bx/bl)
            if ax*by-ay*bx < -1e-8:
                # A concave notch needs a round offset join. A miter shoots
                # across the diagonal and falsely disconnects the red face.
                start,end = math.atan2(n[1],n[0]),math.atan2(mn[1],mn[0])
                while end>start:end-=math.tau
                steps=max(1,math.ceil((start-end)/.20))
                for j in range(steps+1):
                    angle=start+(end-start)*j/steps
                    path.append((x+math.cos(angle)*amount,y+math.sin(angle)*amount))
            else:
                distance=amount/max(.001,1+n[0]*mn[0]+n[1]*mn[1])
                path.append((x+(n[0]+mn[0])*distance,y+(n[1]+mn[1])*distance))
        for _ in range(len(path)):
            crossing = None
            for i in range(len(path)):
                a,b = path[i],path[(i+1)%len(path)]
                for j in range(i+2,len(path)):
                    if i == 0 and j == len(path)-1:
                        continue
                    c,d = path[j],path[(j+1)%len(path)]
                    dx,dy,ex,ey = b[0]-a[0],b[1]-a[1],d[0]-c[0],d[1]-c[1]
                    det = dx*ey-dy*ex
                    if abs(det)<1e-10: continue
                    t = ((c[0]-a[0])*ey-(c[1]-a[1])*ex)/det
                    u = ((c[0]-a[0])*dy-(c[1]-a[1])*dx)/det
                    if 0<t<1 and 0<u<1:
                        crossing = (i,j,(a[0]+t*dx,a[1]+t*dy)); break
                if crossing: break
            if not crossing: return ccw(path)
            i,j,p = crossing
            candidates = [path[:i+1]+[p]+path[j+1:],[p]+path[i+1:j+1]]
            path = max(candidates,key=lambda ring:abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(ring,ring[1:]+ring[:1]))))
        raise ValueError('Seven offset did not converge')
    solid(m,outline,-.26,.11,.028,'seven_gold')
    moulding(m,inner(.035),.14,.028,.039,'seven_gold',segments=8)
    solid(m,inner(.065),.105,.19,0,'seven_border')
    moulding(m,inner(.090),.211,.012,.016,'seven_chrome',segments=8)
    face = inner(.115)
    solid(m,face,.17,.225,0,'seven_enamel')
    crowned_cap(m,face,.226,.060,'seven_enamel')


def build_seven(geo):
    make_seven(Model(geo))



def stage_path(points):
    return ccw([((x-530)/100,(870-y)/100) for x,y in points])


def resample(path,count=128):
    edges=list(zip(path,path[1:]+path[:1]))
    lengths=[math.dist(a,b) for a,b in edges]
    total=sum(lengths)
    out=[]
    for i in range(count):
        distance=i*total/count
        for (a,b),length in zip(edges,lengths):
            if distance<=length:
                t=distance/length
                out.append((a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t));break
            distance-=length
    return out


def arch_outline():
    points=[(186,661),(186,244)]
    for controls in [((186,244),(181,215),(192,205),(213,197)),
                     ((213,197),(350,125),(375,164),(530,194)),
                     ((530,194),(680,164),(711,125),(850,197)),
                     ((850,197),(873,206),(878,220),(876,244))]:
        points += [p[:2] for p in bezier(controls,16)[1:]]
    points += [(876,661),(855,683),(208,683)]
    return stage_path(points)


def gem(m,x,y,rx,ry,z):
    setting=ellipse(x,y,rx+6,ry+6,40)
    rounded_solid(m,setting,z-.10,z+.05,.025,'cabinet_shadow')
    moulding(m,setting,z+.04,.036,.043,'cabinet_gold')
    rings=[]
    for scale,depth in ((1,z+.055),(.80,z+.13),(.48,z+.27)):
        rings.append([((x-530+rx*scale*math.cos(i*math.tau/10))/100,
                       (870-y+ry*scale*math.sin(i*math.tau/10))/100,depth) for i in range(10)])
    for a,b in zip(rings,rings[1:]): walls(m,a,b,'cabinet_ruby')
    flat(m,rings[-1],(0,0,1),'cabinet_ruby')


def petal(m,controls,width,height,z,material='cabinet_gold'):
    """Cast acanthus leaf with a curved central rib and rolled, tapering sides."""
    controls=[((x-530)/100,(870-y)/100,z) for x,y in controls]
    p=[hou.Vector3(q) for q in controls]
    def curve(u): return p[0]*(1-u)**3+p[1]*3*u*(1-u)**2+p[2]*3*u*u*(1-u)+p[3]*u**3
    def point(u,v):
        u=max(.00001,min(.99999,u))
        q=curve(u); tangent=(curve(min(1,u+.001))-curve(max(0,u-.001))).normalized()
        across=hou.Vector3((-tangent[1],tangent[0],0)); t=v*2-1
        q+=across*(width/100)*math.sin(math.pi*u)**.75*t
        q[2]+=height*math.sin(math.pi*u)**.8*(1-t*t*.82)
        return q
    def surface(u,v):
        q=point(u,v)
        du=point(min(1,u+.001),v)-point(max(0,u-.001),v)
        dv=point(u,min(1,v+.001))-point(u,max(0,v-.001))
        n=du.cross(dv).normalized()
        if n[2]<0:n*=-1
        return tuple(q),tuple(n)
    m.grid(surface,16,6,material)
    for v in (.5,):
        m.tube([tuple(point(i/20,v)+hou.Vector3((0,0,.009))) for i in range(21)],.009 if v==.5 else .005,'cabinet_highlight',sides=6)


def scroll(m,x,y,scale,side,z):
    points=[]
    for i in range(45):
        t=i/44; a=t*math.pi*2.1
        radius=scale*(1-t*.91)
        points.append(((x-530+side*math.cos(a)*radius)/100,(870-y+math.sin(a)*radius*.8)/100,z+.055*math.sin(math.pi*t)))
    m.tube(points,.044,'cabinet_gold',sides=10)
    m.sphere(points[-1],(.058,.058,.037),'cabinet_highlight',segments=12,rows=8)


def ornament(m,x,y,span,side,z):
    for i in range(5):
        reach=span*(.34+i*.16)
        end=(x+side*reach,y-10-i*8)
        controls=[(x,y),(x+side*reach*.22,y-18-i*4),(x+side*reach*.70,y-32-i*7),end]
        petal(m,controls,6+i*.7,.055+i*.013,z+i*.008)
    scroll(m,x+side*span*.83,y-span*.26,span*.23,side,z+.02)


def build_cabinet(geo):
    m=Model(geo)
    arch=arch_outline()
    rear=[(x*.93,(y-3.5)*.94+3.5) for x,y in arch]
    loft_shell(m,[(rear,-2.85),(rear,-2.75),(arch,-.30),(arch,.04)],'cabinet_body')
    # Both front boundaries are sampled in perimeter order for a clean open annulus.
    outer=resample(arch)
    window=rectangle(242,263,572,375,10)
    inner=resample(window)
    frame(m,outer,inner,.02,.31,0,'cabinet_lacquer')
    moulding(m,inset(arch,.025),.33,.074,.080,'cabinet_gold',segments=12)
    moulding(m,inset(arch,.145),.33,.015,.022,'cabinet_highlight')
    # A broad bowed green-marble inlay defines the upper silhouette.
    for side in (-1,1):
        points=[]
        for controls in [((530,204),(530+side*108,137),(530+side*224,148),(530+side*302,209)),
                         ((530+side*302,209),(530+side*179,177),(530+side*102,207),(530,227))]:
            points += [p[:2] for p in bezier(controls,24)]
        panel=stage_path(points)
        solid(m,panel,.32,.41,0,'cabinet_marble')
        moulding(m,panel,.43,.036,.044,'cabinet_gold')
        ornament(m,530+side*100,199,77,side,.48)
    # A tall ruby crest with actual gold leaves, open curls and a faceted stone.
    for side in (-1,1):
        for i in range(5):
            petal(m,[(530+side*12,224),(530+side*(52+i*9),213-i*4),
                     (530+side*(29+i*17),136+i*9),(530+side*(15+i*22),143+i*13)],
                  14+i*1.2,.16+i*.02,.52+i*.012)
        scroll(m,530+side*83,201,26,side,.58)
    gem(m,530,186,21,40,.73)
    petal(m,[(530,147),(506,135),(521,127),(530,135)],6,.08,.64)
    # Curved marquee ribbon and individual glass bulbs beneath the crest.
    top=[]; bottom=[]
    for i in range(41):
        x=233+i*594/40; y=239-16*math.sin(math.pi*i/40)
        top.append((x,y-5));bottom.append((x,y+11))
    ribbon=stage_path(top+list(reversed(bottom)))
    solid(m,ribbon,.31,.39,0,'cabinet_lacquer')
    for points in (top,bottom):
        m.tube([((x-530)/100,(870-y)/100,.42) for x,y in points],.018,'cabinet_gold')
    for i in range(11):
        x=252+i*55.2;y=243-16*math.sin(math.pi*(x-233)/594)
        m.sphere(((x-530)/100,(870-y)/100,.46),(.076,.076,.035),'cabinet_gold',segments=16,rows=10)
        m.sphere(((x-530)/100,(870-y)/100,.493),(.049,.049,.045),'cabinet_lamp',segments=16,rows=10)
    moulding(m,rectangle(229,253,598,398,17),.38,.052,.065,'cabinet_gold',segments=12)
    moulding(m,rectangle(239,261,578,380,11),.34,.018,.023,'cabinet_chrome')
    # The fluted, caged glass columns sit proud of the opening.
    for x in (205,852):
        for y in (282,622):
            shell=rectangle(x-24,y-34,48,68,16)
            rounded_solid(m,shell,.32,.79,.09,'cabinet_gold',steps=4)
            moulding(m,inset(shell,.04),.76,.016,.026,'cabinet_chrome')
            gem(m,x,y,10,21,.79)
        for y in (316,328,568,580):
            m.torus(((x-530)/100,(870-y)/100,.64),.235,.040,'cabinet_gold',segments=40)
        for dx in (-18,-11,11,18):
            m.tube([((x+dx-530)/100,(870-y)/100,.76) for y in (331,345,555,566)],.015,'cabinet_gold')
    # Deep sides with a medallion; these remain modeled in the editable prop.
    for side in (-1,1):
        panel=SidePanel(m,side)
        path=ccw([(-.73,1),(.93,1),(1.08,5.6),(.73,6.25),(-.6,5.9)])
        solid(panel,path,.04,.11,.02,'cabinet_marble')
        moulding(panel,inset(path,.06),.12,.025,.020,'cabinet_gold')
        circle=ccw([(.12+math.cos(i*math.tau/64)*.68,2.5+math.sin(i*math.tau/64)*.84) for i in range(64)])
        moulding(panel,circle,.14,.075,.075,'cabinet_gold')
        solid(panel,inset(circle,.07),.13,.15,0,'cabinet_black')
        for i in range(32):
            a=i*math.tau/32
            p=[(.12+math.cos(a)*r,2.5+math.sin(a)*r*1.25,.19) for r in (.45,.6)]
            # The adaptor handles actual side-facing geometry and normals.
            panel.face([(p[0][0]-.006,p[0][1],.18),(p[1][0]-.006,p[1][1],.18),
                        (p[1][0]+.006,p[1][1],.18),(p[0][0]+.006,p[0][1],.18)],[(0,0,1)]*4,'cabinet_gold')
    # The projecting deck is narrower than the old flat tray, with a curved apron.
    deck=rounded_outline(stage_path([(184,656),(875,656),(907,701),(922,823),(901,867),(159,867),(137,824),(150,707)]),.20)
    loft_shell(m,[([(x*.95,y) for x,y in deck],-2.85),(deck,.48),(inset(deck,.06),.93)],'cabinet_body',close_front=True)
    moulding(m,inset(deck,.065),.94,.048,.057,'cabinet_gold',segments=12)
    moulding(m,inset(deck,.14),.95,.013,.015,'cabinet_chrome')
    # Dark green lower apron and a second cast ornament centered on a ruby.
    apron=rectangle(171,819,717,37,15)
    solid(m,apron,.94,.99,.02,'cabinet_marble')
    moulding(m,apron,1.00,.020,.025,'cabinet_gold')
    for side in (-1,1): ornament(m,530,839,82,side,1.03)
    gem(m,530,833,7,15,1.10)
    # Left vertical payout plaque and right ornamental marble insert.
    for x,w,material in ((182,163,'cabinet_black'),(704,170,'cabinet_marble')):
        plaque=rectangle(x,703,w,106,14)
        rounded_solid(m,plaque,.96,1.02,.023,'cabinet_shadow')
        solid(m,inset(plaque,.03),1.015,1.04,0,material)
        moulding(m,plaque,1.05,.025,.032,'cabinet_gold')
        for px in (x+7,x+w-7):
            for py in (710,802):m.sphere(((px-530)/100,(870-py)/100,1.065),(.031,.031,.017),'cabinet_highlight',segments=12,rows=8)
    for i in range(6):
        petal(m,[(724,791),(771+i*10,797-i*5),(832+i*4,782-i*13),(816+i*6,724+i*5)],8,.09,1.055+i*.006)
    scroll(m,808,754,30,1,1.10)
    # Domed ruby switch: machined socket, gasket, clear lacquer and raised text in the UI.
    for rx,ry,back,front,material in ((158,69,.94,1.04,'cabinet_shadow'),(150,63,1.01,1.15,'cabinet_gold'),
                                   (140,55,1.14,1.21,'cabinet_chrome'),(134,50,1.20,1.25,'cabinet_black')):
        rounded_solid(m,ellipse(525,754,rx,ry,64),back,front,.025,material,steps=4)
    m.sphere((-.05,1.16,1.245),(1.27,.46,.22),'cabinet_spin_button',segments=64,rows=28)
    moulding(m,ellipse(525,754,127,46,64),1.245,.015,.025,'cabinet_gold')
    # A narrow black plinth keeps gold highlights away from broad, flat bands.
    rounded_solid(m,rectangle(152,868,755,29,12),-2.85,.92,.07,'cabinet_black',steps=4)
    for y in (867,890):moulding(m,rectangle(153,y,754,4,2),.94,.012,.022,'cabinet_gold')
    for x in (186,819):rounded_solid(m,rectangle(x,895,54,11,5),-2.7,.62,.025,'cabinet_gold')
    m.sphere((3.54,3.15,-.20),(.26,.26,.26),'cabinet_gold',segments=24,rows=16)
    m.stem([(3.55,3.15,-.20),(4.06,3.20,-.08),(4.01,4.6,.08),(4.03,4.8,.08)],.065,'cabinet_chrome',steps=24)
    m.sphere((4.03,4.83,.08),(.24,.26,.24),'cabinet_ruby',segments=40,rows=24)
    m.torus((4.03,4.6,.08),.105,.025,'cabinet_gold',segments=24)
    # Complete ivory drums remain in the native model; game strips occupy this cavity.
    for index,left in enumerate((248,437,626)):
        for i in range(64):
            a,b=i*math.tau/64,(i+1)*math.tau/64
            points=[((x-530)/100,4.19+math.sin(t)*2.05,-1.88+math.cos(t)*2.05)
                    for x,t in ((left,a),(left+178,a),(left+178,b),(left,b))]
            m.face(points,[(0,math.sin(t),math.cos(t)) for t in (a,a,b,b)],'cabinet_reel_'+str(index))


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
