// flight-tube.js — Three.js TubeGeometry custom layer for MapLibre GL JS.
// Loaded as <script type="module" src="js/flight-tube.js">.
// Exposes window._addTubePath(mlMap, wps) called by toggle3DView() on map load.
//
// Coordinate mapping:  translate(origin) · scale(sc,−sc,sc) · rotateX(π/2) converts
// Three.js local metres (x=east, y=altitude, z=south) to MapLibre Mercator space.
import * as THREE from 'three';

const LOITER_TYPES = new Set(['loiter','loiter_time','loiter_turns','loiter_to_alt']);

window._addTubePath = function (mlMap, wps) {
  if (!wps || wps.length < 2 || wps[0].lon == null || wps[0].lat == null) return;

  // Mercator origin at first waypoint, altitude=0.  All other points expressed
  // as metres offset from this origin so float precision is preserved.
  let origin, sc;
  try {
    origin = maplibregl.MercatorCoordinate.fromLngLat([wps[0].lon, wps[0].lat], 0);
    sc = origin.meterInMercatorCoordinateUnits(); // 1 m → Mercator units
  } catch(e) { console.error('[flight-tube] coordinate error', e); return; }

  function toLocal(w) {
    let m;
    try {
      m = maplibregl.MercatorCoordinate.fromLngLat([w.lon, w.lat], w.alt);
    } catch(e) { console.error('[flight-tube] coordinate error', e); return; }
    return new THREE.Vector3(
      (m.x - origin.x) / sc,
       m.z / sc,
      (m.y - origin.y) / sc
    );
  }

  // Straight path through all waypoint centres (loiters included).
  const pts = wps.map(toLocal);

  mlMap.addLayer({
    id: 'flight-tube', type: 'custom', renderingMode: '3d',

    onAdd (map, gl) {
      this.map = map;
      this.renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(), context: gl, antialias: true
      });
      this.renderer.autoClear = false;
      this.camera = new THREE.Camera();
      this.scene  = new THREE.Scene();

      // ── Main flight path tube ──────────────────────────────────────────
      const pathCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
      const pathGeo   = new THREE.TubeGeometry(pathCurve, Math.max(pts.length * 20, 80), 5, 12, false);
      const pathMat   = new THREE.MeshPhongMaterial({
        color: 0xff8c00, emissive: 0xff4400, emissiveIntensity: 0.45,
        shininess: 90, transparent: true, opacity: 0.92, side: THREE.DoubleSide
      });
      this.scene.add(new THREE.Mesh(pathGeo, pathMat));

      // ── Loiter orbit rings — separate CLOSED tubes, one per loiter WP ──
      // Using a closed CatmullRomCurve3 with 128 evenly-spaced points
      // guarantees a near-perfect circle, independently of the main path.
      const RING_PTS = 128;
      const ringMat  = new THREE.MeshPhongMaterial({
        color: 0xa29bfe, emissive: 0x6c5ce7, emissiveIntensity: 0.5,
        transparent: true, opacity: 0.85, side: THREE.DoubleSide
      });
      for (const w of wps) {
        if (!LOITER_TYPES.has(w.action)) continue;
        const r = Math.max(w.loiterR != null ? w.loiterR : 20, 5);
        const c = toLocal(w);
        const ringPoints = [];
        for (let k = 0; k < RING_PTS; k++) {
          const a = (k / RING_PTS) * 2 * Math.PI;
          ringPoints.push(new THREE.Vector3(
            c.x + r * Math.sin(a),
            c.y,
            c.z + r * Math.cos(a)
          ));
        }
        // closed=true → CatmullRom wraps perfectly back to start → circle
        const ringCurve = new THREE.CatmullRomCurve3(ringPoints, true, 'catmullrom', 0.5);
        const ringGeo   = new THREE.TubeGeometry(ringCurve, RING_PTS * 3, 4, 8, true);
        this.scene.add(new THREE.Mesh(ringGeo, ringMat));
      }

      this.scene.add(new THREE.AmbientLight(0xffffff, 2.0));
      const dir = new THREE.DirectionalLight(0xffffff, 2.0);
      dir.position.set(0.5, 1.0, 0.3).normalize();
      this.scene.add(dir);

      this.origin = origin;
      this.sc     = sc;
    },

    onRemove () {
      this.scene.children.forEach(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      });
      this.renderer.dispose();
      this.scene.clear();
      this.renderer = null;
      this.scene    = null;
      this.camera   = null;
    },

    render (gl, matrix) {
      const proj  = new THREE.Matrix4().fromArray(matrix);
      const model = new THREE.Matrix4()
        .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
        .scale(new THREE.Vector3(this.sc, -this.sc, this.sc))
        .multiply(
          new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2)
        );
      this.camera.projectionMatrix = proj.multiply(model);
      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
      this.map.triggerRepaint();
    }
  });
};
