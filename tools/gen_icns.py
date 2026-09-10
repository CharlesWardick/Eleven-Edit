"""
Generates assets/icon.icns — the macOS app icon — from the same "Rack Rails"
drawing code as gen_icon.py (imported, not copied), drawn natively at every
size Apple's iconset wants (16..512 plus @2x up to 1024) and packed with
iconutil. Run from anywhere:  python3 tools/gen_icns.py
"""
import os, shutil, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_icon import make_icon, ASSETS  # noqa: E402

out = os.path.join(ASSETS, "icon.icns")
work = tempfile.mkdtemp()
iconset = os.path.join(work, "icon.iconset")
os.mkdir(iconset)
for base in (16, 32, 128, 256, 512):
    make_icon(base).save(os.path.join(iconset, f"icon_{base}x{base}.png"))
    make_icon(base * 2).save(os.path.join(iconset, f"icon_{base}x{base}@2x.png"))
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out], check=True)
shutil.rmtree(work)
print("wrote", out, os.path.getsize(out), "bytes")
