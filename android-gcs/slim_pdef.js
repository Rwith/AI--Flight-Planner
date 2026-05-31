// Slim ArduPilot apm.pdef.json files to only the metadata our UI uses.
// Flattens nested groups, keeps DisplayName/Units/Values/Bitmask, drops params
// with none of those.
const fs = require('fs');
const path = require('path');

function flatten(obj, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const isParamLeaf = ('DisplayName' in v) || ('Description' in v) ||
                          ('Values' in v) || ('Bitmask' in v);
      if (isParamLeaf) {
        const slim = {};
        if (v.DisplayName) slim.n = v.DisplayName;
        if (v.Units)       slim.u = v.Units;
        if (v.Values)      slim.v = v.Values;
        if (v.Bitmask)     slim.b = v.Bitmask;
        if (Object.keys(slim).length > 0) out[k] = slim;
      } else {
        flatten(v, out);
      }
    }
  }
}

for (const veh of ['copter', 'plane', 'rover']) {
  const inPath  = path.join(__dirname, 'app/src/main/assets/apm_pdef_' + veh + '.json');
  const outPath = path.join(__dirname, 'app/src/main/assets/pdef_' + veh + '.json');
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const out = {};
  flatten(data, out);
  // Drop params that have no Values or Bitmask AND no display info worth keeping —
  // we only need entries the editor will actually use.
  const filtered = {};
  for (const [k, v] of Object.entries(out)) {
    // Keep only entries with dropdown/bitmask metadata — that's all the editor uses.
    if (v.v || v.b) {
      const slim = {};
      if (v.v) slim.v = v.v;
      if (v.b) slim.b = v.b;
      filtered[k] = slim;
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(filtered));
  console.log(veh + ': ' + Object.keys(out).length + ' total, ' +
              Object.keys(filtered).length + ' kept, ' +
              fs.statSync(outPath).size + ' bytes');
}
