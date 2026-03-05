// flight-tube.js — Three.js TubeGeometry custom layer for MapLibre GL JS.
// Loaded as <script type="module" src="js/flight-tube.js">.
// Exposes window._addTubePath(mlMap, wps) called by toggle3DView() on map load.
//
// Coordinate mapping:  translate(origin) · scale(sc,−sc,sc) · rotateX(π/2) converts
// Three.js local metres (x=east, y=altitude, z=south) to MapLibre Mercator space.
import * as THREE from 'three';

window._addTubePath = function (mlMap, wps) {
  if (!wps || wps.length < 2) return;

  // Mercator origin at first waypoint, altitude=0.  All other points expressed
  // as metres offset from this origin so float precision is preserved.
  const origin = maplibregl.MercatorCoordinate.fromLngLat([wps[0].lon, wps[0].lat], 0);
  const sc = origin.meterInMercatorCoordinateUnits(); // 1 m → Mercator units

  // (x_t, y_t, z_t) in Three.js local space → Mercator (origin.x + x_t·sc,
  //                                                        origin.y + z_t·sc,
  //                                                        origin.z + y_t·sc)
  // Therefore:  x_t = (m.x − origin.x)/sc  (east, metres)
  //             y_t = m.z / sc             (altitude, metres ≈ w.alt)
  //             z_t = (m.y − origin.y)/sc  (south, metres)
  const pts = wps.map(w => {
    const m = maplibregl.MercatorCoordinate.fromLngLat([w.lon, w.lat], w.alt);
    return new THREE.Vector3(
      (m.x - origin.x) / sc,
       m.z / sc,
      (m.y - origin.y) / sc
    );
  });

  mlMap.addLayer({
    id: 'flight-tube', type: 'custom', renderingMode: '3d',

    onAdd (map, gl) {
      this.map = map;
      // Reuse MapLibre's WebGL context — do NOT create a new one.
      this.renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(), context: gl, antialias: true
      });
      this.renderer.autoClear = false;

      // Raw Camera: projection matrix is set manually each frame from the
      // MapLibre matrix, so no perspective setup is needed.
      this.camera = new THREE.Camera();

      this.scene = new THREE.Scene();

      // Catmull-Rom spline smooths sharp kinks at waypoint turns.
      const curve    = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
      const segments = Math.max(wps.length * 20, 80);

      // radius = 5 m, 12 radial segments → visually smooth circle at drone
      // planning zoom levels (zoom 15–18).
      const geo = new THREE.TubeGeometry(curve, segments, 5, 12, false);
      const mat = new THREE.MeshPhongMaterial({
        color:             0xff8c00,   // amber-orange
        emissive:          0xff4400,   // red-orange inner glow
        emissiveIntensity: 0.45,
        shininess:         90,
        transparent:       true,
        opacity:           0.92,
        side:              THREE.DoubleSide
      });
      this.scene.add(new THREE.Mesh(geo, mat));
      this.scene.add(new THREE.AmbientLight(0xffffff, 2.0));
      const dir = new THREE.DirectionalLight(0xffffff, 2.0);
      dir.position.set(0.5, 1.0, 0.3).normalize();
      this.scene.add(dir);

      this.origin = origin;
      this.sc     = sc;
    },

    onRemove () {
      this.renderer.dispose();
      this.scene.clear();
    },

    render (gl, matrix) {
      // Build model-to-Mercator matrix then premultiply by MapLibre's
      // view+projection matrix so the tube is rendered in clip space.
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
