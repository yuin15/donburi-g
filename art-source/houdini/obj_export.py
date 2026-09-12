"""Compact Houdini's OBJ tables without changing faces, groups or normals."""


def compact_obj(asset):
    tables = {kind: [] for kind in ("v", "vt", "vn")}
    unique = {kind: {} for kind in tables}
    indices = {kind: [0] for kind in tables}
    faces = []
    for line in asset.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if not parts or parts[0] == "#":
            continue
        kind = parts[0]
        if kind in tables:
            values = tuple(str(round(float(value), 5)) for value in parts[1:])
            index = unique[kind].get(values)
            if index is None:
                tables[kind].append(" ".join((kind, *values)))
                index = len(tables[kind])
                unique[kind][values] = index
            indices[kind].append(index)
        elif kind == "f":
            corners = []
            for corner in parts[1:]:
                values = corner.split("/")
                for i, value in enumerate(values):
                    if value:
                        index = int(value)
                        values[i] = str(indices[("v", "vt", "vn")[i]][index])
                corners.append("/".join(values))
            faces.append("f " + " ".join(corners))
        else:
            faces.append(line.rstrip())
    lines = ["# Houdini Apprentice / Slot-chan non-commercial demo"]
    for table in tables.values():
        lines.extend(table)
    asset.write_text("\n".join(lines + faces) + "\n", encoding="utf-8")
