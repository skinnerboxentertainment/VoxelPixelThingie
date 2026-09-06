"""Import a GLB into Blender and export it again (PLAN-4.md Phase 23).

    blender -b --python scripts/blender-roundtrip.py -- <in.glb> <out.glb> [move <object name> <x> <y> <z>]

Custom properties (glTF extras) are carried both ways, so a bit's identity
survives Blender. With `move`, one object is translated before the export,
the edit the import must read back as one `moved` event.
"""
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :]
src, dst = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src, import_shading="FLAT")
objects = [o for o in bpy.data.objects]
print(f"imported {len(objects)} objects, {len(bpy.data.materials)} materials")
if len(argv) >= 6 and argv[2] == "move":
    name = argv[3]
    o = bpy.data.objects[name]
    o.location = (float(argv[4]), float(argv[5]), float(argv[6]))
    print(f"moved {name} to {tuple(o.location)}")
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_extras=True, export_apply=True)
print(f"exported {dst}")
