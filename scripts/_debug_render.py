import sys
sys.path.insert(0, 'scripts')
from render_brand_icons import parse_path, point_on_segment, points_along_path

poly = [(x, y) for (_c, x, y) in parse_path('M462 236 L462 420 L624 420')]
print('poly:', poly)
pts = list(points_along_path(poly, 10))
for p in pts:
    print(p)
