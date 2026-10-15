"""Demo radar files for the screenshots: a rain front crossing the demo forest near Zurich in four steps,
in the layout of MeteoSwiss' RZC files (ODIM HDF5, here a 2 km grid over the 710 x 640 km composite).
Needs h5py and numpy: python3 make.py (writes front-0.h5 … front-3.h5 next to this file)."""
import math, os, h5py, numpy as np

here = os.path.dirname(os.path.abspath(__file__))
nx, ny, cell = 355, 320, 2000
llx, lly = 2255000, 840000

def noise(x, y):
    return (math.sin(x / 9000) * math.cos(y / 7000) + math.sin((x + y) / 4300) * 0.6 + math.cos(x / 2600 - y / 3900) * 0.35)

for step in range(4):
    data = np.zeros((ny, nx), dtype=np.uint8)
    for j in range(ny):
        y = lly + (ny - j - 0.5) * cell
        for i in range(nx):
            x = llx + (i + 0.5) * cell
            # A front from south-west to north-east, moving east 12 km per step, centred on the demo forest at its last step.
            d = ((x - (2683500 - (3 - step) * 12000)) * 0.6 - (y - 1247000) * 0.8)
            core = math.exp(-((d / 14000) ** 2)) * (0.75 + 0.35 * noise(x, y))
            rate = 18 * core ** 2 if core > 0.18 else 0  # mm/h
            data[j, i] = min(254, round(rate / 0.1))
    data[0:2, 0:2] = 255
    with h5py.File(os.path.join(here, f'front-{step}.h5'), 'w') as f:
        s = np.bytes_
        f.attrs['Conventions'] = s('ODIM_H5/V2_2')
        w = f.create_group('where')
        for k, v in {'xsize': nx, 'ysize': ny}.items(): w.attrs[k] = np.int64(v)
        for k, v in {'xscale': cell, 'yscale': cell, 'LL_x': llx, 'LL_y': lly}.items(): w.attrs[k] = np.float64(v)
        q = f.create_group('dataset1').create_group('data1')
        what = q.create_group('what')
        what.attrs['quantity'] = s('RATE')
        for k, v in {'gain': 0.1, 'offset': 0.0, 'nodata': 255.0, 'undetect': 0.0}.items(): what.attrs[k] = np.float64(v)
        q.create_dataset('data', data=data, compression='gzip', compression_opts=9)
