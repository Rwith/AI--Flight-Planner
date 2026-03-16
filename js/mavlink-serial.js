// mavlink-serial.js — Web Serial API bridge for ArduPilot/PX4 flight computers.
// Provides: live MAVLink telemetry (blackbox reader) + waypoint upload.
// Works in Chrome/Edge 89+.  Exposes: window.serialConnect(), serialUploadWaypoints().
(function () {
  'use strict';

  // ─── MAVLink CRC-16 / MCRF4XX ────────────────────────────────────────────
  // CRC extra bytes for each message ID we handle (send or receive).
  const CRC_EXTRA = {
    0: 50,   // HEARTBEAT
    1: 124,  // SYS_STATUS
    24: 24,  // GPS_RAW_INT
    30: 39,  // ATTITUDE
    33: 104, // GLOBAL_POSITION_INT
    40: 230, // MISSION_REQUEST
    44: 221, // MISSION_COUNT
    47: 153, // MISSION_ACK
    51: 196, // MISSION_REQUEST_INT
    73: 38,  // MISSION_ITEM_INT
    74: 20,  // VFR_HUD
    66: 148, // REQUEST_DATA_STREAM
    253: 83, // STATUSTEXT
    // ── DataFlash log download ─────────────────────────────────────────────
    // LOG_DATA (120) intentionally omitted — MAVLink v2 zero-trims payload so
    // the CRC varies by packet length; skip validation and accept all LOG_DATA.
    117: 128, // LOG_REQUEST_LIST (sent by us)
    118: 56,  // LOG_ENTRY        (received — validated, confirmed correct)
    119: 116, // LOG_REQUEST_DATA (sent by us)
    122: 203, // LOG_REQUEST_END  (sent by us)
    11:  89,  // SET_MODE              (sent by us — change flight mode)
    76:  152, // COMMAND_LONG          (sent by us — arm/disarm, etc.)
    70:  124  // RC_CHANNELS_OVERRIDE  (sent by us — joystick RC input)
  };

  function crc16 (data) {
    let crc = 0xFFFF;
    for (const b of data) {
      let tmp = b ^ (crc & 0xFF);
      tmp = (tmp ^ (tmp << 4)) & 0xFF;
      crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF;
    }
    return crc;
  }

  // ─── MAVLink v1 frame builder ─────────────────────────────────────────────
  let _txSeq = 0;
  const GCS_SYS  = 255; // GCS system ID (standard)
  const GCS_COMP = 190; // GCS component ID (standard)

  function buildFrame (msgId, payload) {
    const len   = payload.length;
    const seq   = (_txSeq++) & 0xFF;
    const extra = CRC_EXTRA[msgId] ?? 0;
    const crcInput = [len, seq, GCS_SYS, GCS_COMP, msgId, ...payload, extra];
    const crc  = crc16(crcInput);
    return new Uint8Array([
      0xFE, len, seq, GCS_SYS, GCS_COMP, msgId,
      ...payload,
      crc & 0xFF, (crc >> 8) & 0xFF
    ]);
  }

  // ─── Payload helpers ──────────────────────────────────────────────────────
  function f32 (v) {
    const b = new ArrayBuffer(4);
    new DataView(b).setFloat32(0, v, true);
    return [...new Uint8Array(b)];
  }
  function u16 (v) { return [v & 0xFF, (v >> 8) & 0xFF]; }
  function u32 (v) {
    const b = new ArrayBuffer(4);
    new DataView(b).setUint32(0, v >>> 0, true);
    return [...new Uint8Array(b)];
  }
  function i32 (v) {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, v, true);
    return [...new Uint8Array(b)];
  }
  function i16 (v) { const n = v < 0 ? v + 65536 : v; return [n & 0xFF, (n >> 8) & 0xFF]; }

  // ─── RC_CHANNELS_OVERRIDE (id=70) ────────────────────────────────────────
  // Wire (reordered by type size): 8×u16 channels, then target_system(u8), target_component(u8)
  // Channel values: 1000–2000 µs (standard RC PWM). 65535 = UINT16_MAX = release/ignore channel.
  function buildRCOverride (tSys, tComp, ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8) {
    return buildFrame(70, [
      ...u16(ch1), ...u16(ch2), ...u16(ch3), ...u16(ch4),
      ...u16(ch5), ...u16(ch6), ...u16(ch7), ...u16(ch8),
      tSys, tComp
    ]);
  }

  // ─── HEARTBEAT (id=0) — GCS keepalive ────────────────────────────────────
  // ArduPilot's log-download code checks last_heartbeat_time < 3000 ms.
  // If we don't send one, it stops streaming LOG_DATA after ~3 seconds.
  // Wire (sorted by size): custom_mode(u32), type(u8), autopilot(u8),
  //   base_mode(u8), system_status(u8), mavlink_version(u8)  → 9 bytes
  function buildHeartbeat () {
    return buildFrame(0, [
      ...u32(0), // custom_mode
      6,         // MAV_TYPE_GCS
      0,         // MAV_AUTOPILOT_GENERIC
      0,         // base_mode
      0,         // MAV_STATE_UNINIT
      3          // mavlink_version
    ]);
  }

  // ─── MISSION_COUNT (id=44) ────────────────────────────────────────────────
  // Wire: count(u16), target_system(u8), target_component(u8)
  function buildMissionCount (count, tSys, tComp) {
    return buildFrame(44, [...u16(count), tSys, tComp]);
  }

  // ─── MISSION_ITEM_INT (id=73) ─────────────────────────────────────────────
  // Wire (sorted by field size, large→small):
  //   param1–4(f32×4), x=lat*1e7(i32), y=lon*1e7(i32), z=alt(f32),
  //   seq(u16), command(u16), target_sys, target_comp, frame, current, autocontinue
  function buildMissionItemInt (seq, lat, lon, alt, cmd, p1, p2, p3, p4, frame, current, autoCont, tSys, tComp) {
    const payload = [
      ...f32(p1),                          // param1
      ...f32(p2),                          // param2
      ...f32(p3),                          // param3
      ...f32(p4),                          // param4
      ...i32(Math.round(lat * 1e7)),       // x = lat ×1e7
      ...i32(Math.round(lon * 1e7)),       // y = lon ×1e7
      ...f32(alt),                         // z = altitude (m)
      ...u16(seq),                         // sequence index
      ...u16(cmd),                         // MAV_CMD
      tSys, tComp, frame, current, autoCont
    ];
    return buildFrame(73, payload);
  }

  // ─── REQUEST_DATA_STREAM (id=66) ─────────────────────────────────────────
  // Asks the FC to start sending a telemetry stream at the given rate (Hz).
  // streamId: 2=EXTENDED_STATUS(SYS_STATUS/battery), 11=EXTRA2(VFR_HUD/speed)
  function buildRequestDataStream (streamId, rateHz, tSys, tComp) {
    return buildFrame(66, [...u16(rateHz), tSys, tComp, streamId, 1 /*start*/]);
  }

  // ─── DataFlash log download frames ───────────────────────────────────────
  // LOG_REQUEST_LIST (117) — wire: start(u16), end(u16), tSys(u8), tComp(u8)
  function buildLogRequestList (tSys, tComp) {
    return buildFrame(117, [...u16(0), ...u16(0xFFFF), tSys, tComp]);
  }

  // LOG_REQUEST_DATA (119) — wire: ofs(u32), count(u32), id(u16), tSys(u8), tComp(u8)
  function buildLogRequestData (logId, ofs, count, tSys, tComp) {
    return buildFrame(119, [...u32(ofs), ...u32(count), ...u16(logId), tSys, tComp]);
  }

  // LOG_REQUEST_END (122) — wire: tSys(u8), tComp(u8)
  function buildLogRequestEnd (tSys, tComp) {
    return buildFrame(122, [tSys, tComp]);
  }

  // ─── SET_MODE (id=11) ─────────────────────────────────────────────────────
  // Wire (sorted large→small): custom_mode(u32), target_system(u8), base_mode(u8)
  // base_mode=1 = MAV_MODE_FLAG_CUSTOM_MODE_ENABLED (required for ArduPilot)
  function buildSetMode (customMode, tSys) {
    return buildFrame(11, [...u32(customMode), tSys, 1]);
  }

  // ─── COMMAND_LONG (id=76) ─────────────────────────────────────────────────
  // Wire: param1–7(f32×7), command(u16), target_sys(u8), target_comp(u8), confirmation(u8)
  function buildCommandLong (tSys, tComp, cmd, p1, p2, p3, p4, p5, p6, p7, confirm) {
    return buildFrame(76, [
      ...f32(p1 ?? 0), ...f32(p2 ?? 0), ...f32(p3 ?? 0), ...f32(p4 ?? 0),
      ...f32(p5 ?? 0), ...f32(p6 ?? 0), ...f32(p7 ?? 0),
      ...u16(cmd),
      tSys, tComp, confirm ?? 0
    ]);
  }

  function requestStreams (tSys, tComp) {
    const ts = tSys ?? 1, tc = tComp ?? 1;
    // Request all streams at 2 Hz as a broad fallback, then explicitly ask for
    // the two streams that carry battery and speed data.
    const ids = [
      0,  // ALL            → broad enable
      2,  // EXTENDED_STATUS → SYS_STATUS (battery voltage/current/%), BATTERY_STATUS (mAh consumed)
      11, // EXTRA2          → VFR_HUD (airspeed, groundspeed, throttle)
      12, // EXTRA3          → ESC_TELEMETRY_1_TO_4 (ESC temp/RPM/current)
    ];
    for (const s of ids) {
      const frame = buildRequestDataStream(s, 2, ts, tc);
      writer?.write(frame).catch(() => {});
    }
    addLog(`[streams] Requested data streams from sysid=${ts}`);
  }

  // ─── Incoming MAVLink parser (v1 + v2) ───────────────────────────────────
  class MAVParser {
    constructor (onMsg) {
      this._buf   = [];
      this._onMsg = onMsg;
    }

    push (bytes) {
      for (const b of bytes) {
        this._buf.push(b);
        this._drain();
      }
    }

    _drain () {
      // Drop bytes until we see a valid start marker.
      while (this._buf.length && this._buf[0] !== 0xFE && this._buf[0] !== 0xFD) {
        this._buf.shift();
      }
      if (!this._buf.length) return;
      if (this._buf[0] === 0xFE) this._tryV1();
      else                        this._tryV2();
    }

    _tryV1 () {
      if (this._buf.length < 8) return;
      const payLen   = this._buf[1];
      const frameLen = 8 + payLen;
      if (this._buf.length < frameLen) return;

      const msgId   = this._buf[5];
      const payload = this._buf.slice(6, 6 + payLen);
      const extra   = CRC_EXTRA[msgId];

      if (extra !== undefined) {
        const crc = crc16([payLen, this._buf[2], this._buf[3], this._buf[4], msgId, ...payload, extra]);
        const lo  = this._buf[6 + payLen], hi = this._buf[7 + payLen];
        if ((crc & 0xFF) !== lo || ((crc >> 8) & 0xFF) !== hi) {
          this._buf.shift(); this._drain(); return;
        }
      }

      this._buf.splice(0, frameLen);
      this._onMsg(msgId, payload);
    }

    _tryV2 () {
      if (this._buf.length < 12) return;
      const payLen   = this._buf[1];
      const frameLen = 12 + payLen;
      if (this._buf.length < frameLen) return;

      const msgId   = this._buf[7] | (this._buf[8] << 8) | (this._buf[9] << 16);
      const payload = this._buf.slice(10, 10 + payLen);
      const extra   = CRC_EXTRA[msgId];

      if (extra !== undefined) {
        const crc = crc16([
          payLen, this._buf[2], this._buf[3], this._buf[4],
          this._buf[5], this._buf[6], this._buf[7], this._buf[8], this._buf[9],
          ...payload, extra
        ]);
        const lo = this._buf[10 + payLen], hi = this._buf[11 + payLen];
        if ((crc & 0xFF) !== lo || ((crc >> 8) & 0xFF) !== hi) {
          this._buf.shift(); this._drain(); return;
        }
      }

      this._buf.splice(0, frameLen);
      this._onMsg(msgId, payload);
    }
  }

  // ─── Connection state ─────────────────────────────────────────────────────
  let port            = null;
  let writer          = null;
  let reader          = null;
  let uploadState     = null;  // { wps, tSys, tComp, resolve, reject }
  let logListState    = null;  // { entries[], numLogs, timer, resolve, reject }
  let logDownState    = null;  // { buf, totalSize, bytesReceived, timer, resolve, reject }
  let wsConn          = null;  // active WebSocket (WiFi backpack mode)
  let flightStartTime = null;  // set on first position telemetry received
  let logPaused       = false;
  let telLog          = [];    // CSV rows for export
  const tele          = {};    // live telemetry snapshot

  // WiFi reconnect state
  let _wifiUrl                = null;   // last attempted URL
  let _wifiMode               = null;   // 'wifi' | 'direct'
  let _wifiIntentional        = false;  // true when user clicked Disconnect
  let _wifiReconnectTimer     = null;
  let _wifiReconnectAttempts  = 0;
  const WIFI_MAX_ATTEMPTS     = 8;
  const WIFI_BACKOFF_MS       = [2000, 3000, 5000, 8000, 10000, 15000, 20000, 30000];

  // Heartbeat watchdog — detects stale / zombie connections
  let _hbWatchdog = null;

  // Live altitude track: array of {dist, alt} where dist = distance from home (m)
  let liveAltLog = [];
  window._getLiveAltPoints = () => liveAltLog;

  // ─── Live drone map marker ────────────────────────────────────────────────
  let droneMarker   = null;  // Leaflet marker showing live FC position
  let homeSet       = false; // true once home has been snapped to 8+ sat fix
  let streamsAsked  = false; // send REQUEST_DATA_STREAM only once per session

  const DRONE_ICON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" id="live-drone-icon" width="22" height="30"
    viewBox="0 0 18 26" style="display:block;filter:drop-shadow(0 1px 6px rgba(0,0,0,.9));transform-origin:9px 13px">
    <polygon points="9,0 18,26 9,19 0,26" fill="#3fb950" stroke="rgba(0,0,0,0.5)" stroke-width="1.2" stroke-linejoin="round"/>
  </svg>`;

  function updateDroneMarker (lat, lon, headingDeg) {
    if (typeof map === 'undefined' || !map) return;
    if (!droneMarker) {
      droneMarker = L.marker([lat, lon], {
        icon: L.divIcon({ className: '', html: DRONE_ICON_HTML, iconSize: [22, 30], iconAnchor: [11, 15] }),
        zIndexOffset: 3000, interactive: false
      }).addTo(map);
    } else {
      droneMarker.setLatLng([lat, lon]);
    }
    const el = document.getElementById('live-drone-icon');
    if (el && headingDeg != null) el.style.transform = `rotate(${headingDeg}deg)`;
  }

  function removeDroneMarker () {
    if (droneMarker) { map?.removeLayer(droneMarker); droneMarker = null; }
    homeSet      = false;
    streamsAsked = false;
  }

  // ─── Telemetry message decoder ────────────────────────────────────────────
  function onMessage (msgId, payload) {
    const dv = new DataView(new Uint8Array(payload).buffer);

    switch (msgId) {
      case 0: { // HEARTBEAT — type, autopilot, base_mode, system_status
        // Wire (sorted 32→8): custom_mode(u32,0), type(u8,4), autopilot(u8,5), base_mode(u8,6), system_status(u8,7), mavlink_version(u8,8)
        if (payload.length >= 9) {
          tele.customMode = dv.getUint32(0, true);
          tele.mavType    = payload[4]; // 1=plane, 2=quad, 13=hex, 14=octo
          tele.baseMode   = payload[6];
          tele.sysStatus  = payload[7];
        }
        // On first heartbeat ask the FC to stream battery + speed data.
        if (!streamsAsked) {
          streamsAsked = true;
          requestStreams(1, 1);
        }
        // Reset heartbeat watchdog — if 6 s pass with no heartbeat on a WiFi
        // connection the socket is likely a zombie; force-close and reconnect.
        if (wsConn) {
          clearTimeout(_hbWatchdog);
          _hbWatchdog = setTimeout(() => {
            if (!wsConn) return;
            addLog('[wifi] No heartbeat for 6 s — connection lost, reconnecting…');
            const staleWs = wsConn;
            wsConn = null; writer = null;
            try { staleWs.close(); } catch {}
            setConnected(false);
            _scheduleWifiReconnect();
          }, 6000);
        }
        renderTele();
        break;
      }
      case 1: { // SYS_STATUS
        // Wire: sensors_present(u32,0), sensors_enabled(u32,4), sensors_health(u32,8),
        //        load(u16,12), voltage_battery(u16,14), current_battery(i16,16),
        //        drop_rate(u16,18), errors_comm(u16,20)×4, battery_remaining(i8,30)
        // NOTE: MAVLink v2 zero-trims trailing bytes, so battery_remaining (byte 30)
        //       may be absent when 0%.  Read each field only if the byte is present.
        if (payload.length >= 16) tele.voltageMv = dv.getUint16(14, true);
        if (payload.length >= 18) tele.currentCa = dv.getInt16(16, true);
        if (payload.length >= 14) tele.cpuLoad   = dv.getUint16(12, true) / 10;
        if (payload.length >= 31) tele.battPct   = dv.getInt8(30);
        else if (tele.battPct == null) tele.battPct = 0; // trimmed → 0%
        renderTele();
        break;
      }
      case 24: { // GPS_RAW_INT
        // Wire: time_usec(u64,0), lat(i32,8), lon(i32,12), alt(i32,16),
        //        eph(u16,20), epv(u16,22), vel(u16,24), cog(u16,26),
        //        fix_type(u8,28), satellites_visible(u8,29)
        if (payload.length >= 30) {
          tele.gpsLat  = dv.getInt32(8, true)  / 1e7;
          tele.gpsLon  = dv.getInt32(12, true) / 1e7;
          tele.gpsAlt  = dv.getInt32(16, true) / 1000;
          tele.gpsFix  = payload[28];
          tele.gpsSats = payload[29];
          tele.hdop    = dv.getUint16(20, true) / 100;
          // Snap home marker to drone's GPS position on first 8+ sat fix.
          if (!homeSet && tele.gpsSats >= 8 && tele.gpsLat && tele.gpsLon) {
            homeSet = true;
            if (typeof homeLat !== 'undefined') {
              homeLat = tele.gpsLat; homeLon = tele.gpsLon;
              if (typeof homeMarker !== 'undefined' && homeMarker) {
                homeMarker.setLatLng([homeLat, homeLon]);
                if (typeof updatePolyline === 'function') updatePolyline();
              }
              addLog(`[home] Set to ${homeLat.toFixed(5)}, ${homeLon.toFixed(5)} (${tele.gpsSats} sats)`);
            }
          }
        }
        renderTele();
        break;
      }
      case 30: { // ATTITUDE
        // Wire: time_boot_ms(u32,0), roll(f32,4), pitch(f32,8), yaw(f32,12),
        //        rollspeed(f32,16), pitchspeed(f32,20), yawspeed(f32,24)
        if (payload.length >= 28) {
          const R2D     = 180 / Math.PI;
          tele.roll     = (dv.getFloat32(4,  true) * R2D).toFixed(1);
          tele.pitch    = (dv.getFloat32(8,  true) * R2D).toFixed(1);
          tele.yawDeg   = (dv.getFloat32(12, true) * R2D).toFixed(1);
        }
        renderTele();
        break;
      }
      case 33: { // GLOBAL_POSITION_INT
        // Wire: time_boot_ms(u32,0), lat(i32,4), lon(i32,8), alt(i32,12),
        //        relative_alt(i32,16), vx(i16,20), vy(i16,22), vz(i16,24), hdg(u16,26)
        if (payload.length >= 28) {
          tele.lat    = dv.getInt32(4,  true) / 1e7;
          tele.lon    = dv.getInt32(8,  true) / 1e7;
          tele.altMSL = dv.getInt32(12, true) / 1000;
          tele.altRel = dv.getInt32(16, true) / 1000;
          tele.hdg    = dv.getUint16(26, true) / 100;
          tele.vx     = dv.getInt16(20, true) / 100;
          tele.vy     = dv.getInt16(22, true) / 100;
          tele.vz     = dv.getInt16(24, true) / 100;
          updateDroneMarker(tele.lat, tele.lon, tele.hdg);
          // Track live altitude vs distance from home for chart overlay
          const hLat = window._serialGetHome?.()?.lat;
          const hLon = window._serialGetHome?.()?.lon;
          if (hLat != null && tele.altRel != null) {
            const R = 6371000, dL = (tele.lat - hLat) * Math.PI / 180, dO = (tele.lon - hLon) * Math.PI / 180;
            const a = Math.sin(dL/2)**2 + Math.cos(hLat*Math.PI/180)*Math.cos(tele.lat*Math.PI/180)*Math.sin(dO/2)**2;
            const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            liveAltLog.push({ dist, alt: tele.altRel });
            if (liveAltLog.length > 2000) liveAltLog.splice(0, 200); // cap at 2000 points
            // Refresh the profile chart live overlay every 10 new points (~1–2 s)
            if (liveAltLog.length % 10 === 0) window._refreshLiveAltOverlay?.();
          }
        }
        flightStartTime = flightStartTime || Date.now();
        logTele();
        renderTele();
        break;
      }
      case 74: { // VFR_HUD
        // Wire: airspeed(f32,0), groundspeed(f32,4), alt(f32,8), climb(f32,12),
        //        heading(i16,16), throttle(u16,18)
        // NOTE: MAVLink v2 trims trailing zero bytes — throttle (bytes 18-19) is
        //       absent when the motor is at 0%.  Read each field conditionally.
        if (payload.length >= 16) {
          tele.airspeed    = dv.getFloat32(0,  true).toFixed(1);
          tele.groundspeed = dv.getFloat32(4,  true).toFixed(1);
          tele.altHUD      = dv.getFloat32(8,  true).toFixed(1);
          tele.climbRate   = dv.getFloat32(12, true).toFixed(2);
        }
        if (payload.length >= 18) tele.heading  = dv.getInt16(16, true);
        tele.throttle = payload.length >= 20 ? dv.getUint16(18, true) : 0;
        renderTele();
        break;
      }
      case 147: { // BATTERY_STATUS
        // Wire: current_consumed(i32,0), energy_consumed(i32,4), temperature(i16,8),
        //        voltages[10](u16×10,10), current_battery(i16,30), id(u8,32),
        //        battery_function(u8,33), type(u8,34), battery_remaining(i8,35)
        if (payload.length >= 4) {
          const consumed = dv.getInt32(0, true);
          if (consumed >= 0) tele.battConsumedMah = consumed; // -1 = unknown
        }
        renderTele();
        break;
      }
      case 11030: { // ESC_TELEMETRY_1_TO_4 (ArduPilot)
        // Wire: temperature[4](u8,0..3), voltage[4](u16,4..11), current[4](u16,12..19),
        //        totalcurrent[4](u16,20..27), rpm[4](u16,28..35), count[4](u16,36..43)
        // Display ESC 1 (index 0) values
        if (payload.length >= 4)  tele.escTemp = payload[0]; // degC
        if (payload.length >= 30) tele.escRpm  = dv.getUint16(28, true);
        if (payload.length >= 14) tele.escCurr = dv.getUint16(12, true) / 100; // cA → A
        renderTele();
        break;
      }
      // ── Waypoint upload handshake ─────────────────────────────────────────
      case 40:   // MISSION_REQUEST
      case 51: { // MISSION_REQUEST_INT
        if (!uploadState) break;
        const seq = dv.getUint16(0, true);
        sendMissionItem(seq);
        break;
      }
      case 47: { // MISSION_ACK
        if (!uploadState) break;
        const mType = payload[2] ?? 0; // MAV_MISSION_RESULT (0 if trailing zero was truncated)
        if (mType === 0) {
          setUploadStatus('Upload complete ✓', 'ok');
          addLog('[upload] Mission accepted by FC');
          uploadState.resolve();
        } else {
          setUploadStatus(`Upload rejected (code ${mType})`, 'err');
          addLog(`[upload] MISSION_ACK type=${mType}`);
          uploadState.reject(new Error('MISSION_ACK ' + mType));
        }
        uploadState = null;
        break;
      }
      case 118: { // LOG_ENTRY — wire: time_utc(u32,0), size(u32,4), id(u16,8), num_logs(u16,10), last_log_num(u16,12)
        if (!logListState) break;
        const leTimeUtc  = payload.length >= 4 ? dv.getUint32(0, true) : 0;
        const leSize     = payload.length >= 8 ? dv.getUint32(4, true) : 0;
        const leId       = payload.length >= 10 ? dv.getUint16(8, true) : 0;
        const leNumLogs  = payload.length >= 12 ? dv.getUint16(10, true) : 1;
        logListState.entries.push({ id: leId, size: leSize, timeUtc: leTimeUtc });
        addLog(`[log] Entry id=${leId} size=${leSize} numLogs=${leNumLogs}`);
        if (logListState.entries.length >= leNumLogs) {
          clearTimeout(logListState.timer);
          const { entries, resolve: res } = logListState;
          logListState = null;
          res(entries);
        }
        break;
      }
      case 120: { // LOG_DATA — wire: ofs(u32,0), id(u16,4), count(u8,6), data[90](7..96)
        if (!logDownState) break;
        const ldOfs   = dv.getUint32(0, true);
        const ldCount = payload[6];

        if (logDownState.highWaterOfs === 0 && ldCount > 0) {
          addLog(`[log] First LOG_DATA — ofs=${ldOfs} count=${ldCount} (download flowing)`);
        }
        logDownState.lastDataAt = Date.now();

        if (ldCount > 0) {
          const chunk = payload.slice(7, 7 + ldCount);
          if (ldOfs + ldCount <= logDownState.totalSize) {
            logDownState.buf.set(chunk, ldOfs);
          }
          if (ldOfs + ldCount > logDownState.highWaterOfs) {
            logDownState.highWaterOfs = ldOfs + ldCount;
          }
          const pct = Math.round(logDownState.highWaterOfs / logDownState.totalSize * 100);
          document.dispatchEvent(new CustomEvent('bb-dl-progress', {
            detail: { pct: Math.min(99, pct), bytes: logDownState.highWaterOfs, total: logDownState.totalSize }
          }));
        }

        // File done: explicit EOF (count=0) or all bytes received
        const fileDone = ldCount === 0 || logDownState.highWaterOfs >= logDownState.totalSize;
        // Chunk done: received all bytes for this chunk (but file continues)
        const chunkDone = !fileDone && logDownState.highWaterOfs >= logDownState.chunkEnd;

        if (fileDone) {
          addLog(`[log] Complete — ${logDownState.highWaterOfs} / ${logDownState.totalSize} bytes`);
          document.dispatchEvent(new CustomEvent('bb-dl-progress', {
            detail: { pct: 100, bytes: logDownState.highWaterOfs, total: logDownState.totalSize }
          }));
          clearTimeout(logDownState.overallTimer);
          clearTimeout(logDownState.chunkTimer);
          const { resolve: res, buf, tSys: s, tComp: c } = logDownState;
          logDownState = null;
          writer?.write(buildLogRequestEnd(s, c)).catch(() => {}); // release FC lock
          res(buf);
        } else if (chunkDone) {
          // Chunk complete — advance window and request the next chunk immediately.
          // ArduPilot already cleared _log_sending_link after sending this chunk,
          // so LOG_REQUEST_DATA will be accepted without a preceding LOG_REQUEST_END.
          clearTimeout(logDownState.chunkTimer);
          logDownState.chunkOfs = logDownState.highWaterOfs;
          logDownState.chunkEnd = Math.min(logDownState.highWaterOfs + CHUNK_SIZE, logDownState.totalSize);
          logDownState.sendChunk();
        }
        break;
      }
      case 253: { // STATUSTEXT — severity + 50-char text
        // Wire: severity(u8,0), text(char[50],1..50)
        if (payload.length < 2) break;
        const severity = payload[0];
        // Read until null terminator or end of field
        let text = '';
        for (let i = 1; i < Math.min(payload.length, 51); i++) {
          if (payload[i] === 0) break;
          text += String.fromCharCode(payload[i]);
        }
        text = text.trim();
        if (!text) break;
        addLog(`[fc] ${text}`);
        window.showStatusText?.(severity, text);
        break;
      }
    }
  }

  // ─── Send one MISSION_ITEM_INT frame ─────────────────────────────────────
  function sendMissionItem (seq) {
    const { wps, tSys, tComp } = uploadState;
    if (seq >= wps.length) return;
    const wp = wps[seq];
    const a = wp.action;
    let cmd, p1=0, p2=0, p3=0, p4=0, lat=wp.lat, lon=wp.lon, alt=wp.alt, frame;

    if (seq === 0 || a === 'home') {
      // Home: NAV_WAYPOINT in absolute frame
      cmd=16; frame=0;
    } else {
      frame=3; // MAV_FRAME_GLOBAL_RELATIVE_ALT for all mission items
      if      (a === 'waypoint')        { cmd=16;  p1=wp.holdTime||0; }
      else if (a === 'spline')          { cmd=82;  p1=wp.holdTime||0; }
      else if (a === 'loiter')          { cmd=17;  p3=wp.loiterR||20; }
      else if (a === 'loiter_time')     { cmd=19;  p1=wp.loiterTime||10; p3=wp.loiterR||20; }
      else if (a === 'loiter_turns')    { cmd=18;  p1=wp.loiterTurns||1; p3=wp.loiterR||20; }
      else if (a === 'loiter_to_alt')   { cmd=31;  p2=wp.loiterR||20; }
      else if (a === 'photo')           { cmd=16; }  // DO_DIGICAM_CONTROL follows as next seq
      else if (a === '_digicam')        { cmd=203; p4=1; lat=0; lon=0; alt=0; }
      else if (a === 'takeoff')         { cmd=22; }
      else if (a === 'vtol_takeoff')    { cmd=84; }
      else if (a === 'land')            { cmd=21; }
      else if (a === 'vtol_land')       { cmd=85; }
      else if (a === 'rtl')             { cmd=20;  lat=0; lon=0; alt=0; }
      // Post-action DO / CONDITION commands
      else if (a === 'delay')           { cmd=93;  p1=wp.delayTime||5; lat=0; lon=0; alt=0; }
      else if (a === 'cond_distance')   { cmd=114; p1=wp.condDist||10; lat=0; lon=0; alt=0; }
      else if (a === 'cond_yaw')        { cmd=115; p1=wp.yawHeading||0; p2=wp.yawSpeed||0; p3=0; p4=wp.yawRel||0; lat=0; lon=0; alt=0; }
      else if (a === 'set_speed')       { cmd=178; p1=wp.speedType??1; p2=wp.speed||5; p3=-1; lat=0; lon=0; alt=0; }
      else if (a === 'do_jump')         { cmd=177; p1=wp.jumpWP||1; p2=wp.jumpRepeat||1; lat=0; lon=0; alt=0; }
      else if (a === 'set_roi')         { cmd=201; p1=3; }
      else if (a === 'set_roi_none')    { cmd=201; p1=0; lat=0; lon=0; alt=0; }
      else if (a === 'set_servo')       { cmd=183; p1=wp.servoNum||9; p2=wp.servoPWM||1500; lat=0; lon=0; alt=0; }
      else if (a === 'do_repeat_servo') { cmd=184; p1=wp.servoNum||9; p2=wp.servoPWM||1500; p3=wp.servoCycles||1; p4=wp.servoDwell||1; lat=0; lon=0; alt=0; }
      else if (a === 'do_set_relay')    { cmd=181; p1=wp.relayNum??0; p2=wp.relayState??1; lat=0; lon=0; alt=0; }
      else if (a === 'do_repeat_relay') { cmd=182; p1=wp.relayNum??0; p2=wp.relayCycles||1; p3=wp.relayDwell||1; lat=0; lon=0; alt=0; }
      else if (a === 'cam_trigg_dist')  { cmd=206; p1=wp.camDist||0; lat=0; lon=0; alt=0; }
      else if (a === 'do_gripper')      { cmd=187; p1=wp.gripperNum??0; p2=wp.gripperAction??0; lat=0; lon=0; alt=0; }
      else if (a === 'do_parachute')    { cmd=208; p1=wp.parachuteCmd??2; lat=0; lon=0; alt=0; }
      else if (a === 'do_mount_control'){ cmd=205; p1=wp.mountPitch||0; p2=wp.mountRoll||0; p3=wp.mountYaw||0; lat=0; lon=0; alt=0; }
      else                              { cmd=16; }
    }

    const current = (seq === 1) ? 1 : 0;
    const frame_ = buildMissionItemInt(seq, lat, lon, alt, cmd, p1, p2, p3, p4, frame, current, 1, tSys, tComp);
    writer.write(frame_).catch(e => addLog('[write] ' + e.message));
    setUploadStatus(`Uploading WP ${seq} / ${wps.length - 1}…`, 'info');
    addLog(`[upload] Sent MISSION_ITEM_INT seq=${seq} cmd=${cmd} lat=${lat} alt=${alt}`);
  }

  // ─── Telemetry rendering ──────────────────────────────────────────────────
  const GPS_FIX_STR = ['No GPS', 'No Fix', '2D Fix', '3D Fix', 'DGPS', 'RTK Float', 'RTK Fixed'];

  function set (id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val ?? '--';
  }

  function renderTele () {
    const gcsActive = document.getElementById('gcs-panel')?.classList.contains('active');

    if (!gcsActive) {
      // Update serial-tab telemetry cells only when GCS mode is off
      const armed = (tele.baseMode & 0x80) ? 'ARMED' : 'DISARMED';
      const armEl = document.getElementById('tele-armed');
      if (armEl) {
        armEl.textContent = armed;
        armEl.style.color = armed === 'ARMED' ? '#f85149' : '#3fb950';
      }
      // Position
      set('tele-lat',     tele.lat     != null ? tele.lat.toFixed(6)    : null);
      set('tele-lon',     tele.lon     != null ? tele.lon.toFixed(6)    : null);
      set('tele-alt-rel', tele.altRel  != null ? tele.altRel.toFixed(1) + ' m' : null);
      set('tele-alt-msl', tele.altMSL  != null ? tele.altMSL.toFixed(1) + ' m' : null);
      set('tele-hdg',     tele.hdg     != null ? tele.hdg.toFixed(0)   + '°' : null);
      // GPS
      set('tele-gps-fix',  GPS_FIX_STR[tele.gpsFix] || null);
      set('tele-gps-sats', tele.gpsSats);
      set('tele-hdop',     tele.hdop   != null ? tele.hdop.toFixed(2) : null);
      // Attitude
      set('tele-roll',  tele.roll  != null ? tele.roll  + '°' : null);
      set('tele-pitch', tele.pitch != null ? tele.pitch + '°' : null);
      set('tele-yaw',   tele.yawDeg != null ? tele.yawDeg + '°' : null);
      // Speed / HUD
      set('tele-airspeed',    tele.airspeed    != null ? tele.airspeed    + ' m/s' : null);
      set('tele-gndspeed',    tele.groundspeed != null ? tele.groundspeed + ' m/s' : null);
      set('tele-climbrate',   tele.climbRate   != null ? tele.climbRate   + ' m/s' : null);
      set('tele-throttle',    tele.throttle    != null ? tele.throttle    + '%' : null);
      // Battery
      set('tele-voltage', tele.voltageMv != null ? (tele.voltageMv / 1000).toFixed(2) + ' V' : null);
      set('tele-current', tele.currentCa != null ? (tele.currentCa / 100).toFixed(1) + ' A' : null);
      set('tele-batt',    tele.battPct   != null && tele.battPct >= 0 ? tele.battPct + '%' : null);
    }

    // HUD instruments and GCS overlay always update regardless of mode
    window.hudUpdate?.(tele);
    window.gcsUpdate?.(tele);
  }

  // ─── Telemetry CSV logger ─────────────────────────────────────────────────
  function logTele () {
    if (logPaused) return;
    telLog.push([
      new Date().toISOString(),
      tele.lat?.toFixed(6) ?? '', tele.lon?.toFixed(6) ?? '',
      tele.altRel?.toFixed(1) ?? '', tele.altMSL?.toFixed(1) ?? '',
      tele.hdg?.toFixed(0) ?? '',
      tele.roll ?? '', tele.pitch ?? '', tele.yawDeg ?? '',
      tele.airspeed ?? '', tele.groundspeed ?? '', tele.climbRate ?? '',
      tele.throttle ?? '',
      (tele.voltageMv / 1000)?.toFixed(2) ?? '', tele.battPct ?? '',
      GPS_FIX_STR[tele.gpsFix] ?? '', tele.gpsSats ?? ''
    ].join(','));
  }

  // ─── Serial log helpers ───────────────────────────────────────────────────
  function addLog (line) {
    const box = document.getElementById('serial-log');
    if (!box) return;
    const d = document.createElement('div');
    d.textContent = new Date().toLocaleTimeString('en', { hour12: false }) + '  ' + line;
    box.appendChild(d);
    // Keep last 200 lines to avoid memory bloat.
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function setUploadStatus (msg, cls) {
    const el = document.getElementById('upload-status');
    if (!el) return;
    el.textContent = msg;
    el.dataset.state = cls || '';
  }

  // ─── Read loop ────────────────────────────────────────────────────────────
  async function readLoop (parser) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        parser.push(value);
      }
    } catch (e) {
      if (e.name !== 'AbortError' && e.name !== 'NetworkError') {
        addLog('[rx] ' + (e.message || e));
      }
    } finally {
      try { reader.releaseLock(); } catch {}
      // If the port closed unexpectedly, update UI.
      if (port) { port = null; writer = null; reader = null; setConnected(false); addLog('[usb] Port closed unexpectedly'); }
    }
  }

  // ─── Auto baud rate detection ─────────────────────────────────────────────
  const AUTO_BAUDS = [57600, 115200, 921600, 230400, 38400];

  async function detectBaud (s, portPath) {
    addLog('[baud] Auto-detecting baud rate — trying ' + AUTO_BAUDS.join(', '));
    for (const baud of AUTO_BAUDS) {
      addLog(`[baud] Trying ${baud}…`);
      s.removeListeners();
      try { await s.open(portPath, baud); } catch (e) { addLog('[baud] open: ' + e); continue; }

      const detected = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 2500);
        const parser = new MAVParser((id) => {
          if (id === 0) { clearTimeout(timer); resolve(true); }
        });
        s.onData(buf => parser.push(buf));
        s.onError(() => { clearTimeout(timer); resolve(false); });
        s.onClose(() => { clearTimeout(timer); resolve(false); });
      });

      if (detected) {
        addLog(`[baud] Heartbeat detected at ${baud} baud`);
        return baud; // port stays open
      }
      try { await s.close(); } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    addLog('[baud] Auto-detect failed — connect manually or pick a baud rate');
    return null;
  }

  // ─── Web Serial API connection (browser-native, Chrome/Edge 89+) ─────────
  async function connectWebSerial () {
    if (!('serial' in navigator)) {
      addLog('[usb] Web Serial API not available — use Chrome / Edge 89+, or the Electron desktop app');
      return;
    }

    // Let the user pick a port — triggers the browser's OS port-picker dialog.
    let wsPort;
    try {
      wsPort = await navigator.serial.requestPort();
    } catch (e) {
      if (e.name !== 'NotFoundError') addLog('[usb] requestPort: ' + e.message);
      return; // user cancelled
    }

    const baudVal   = document.getElementById('serial-baud')?.value ?? 'auto';
    const baudsToTry = baudVal === 'auto' ? AUTO_BAUDS : [parseInt(baudVal, 10)];
    let foundBaud   = null;

    for (const baud of baudsToTry) {
      addLog(`[baud] Trying ${baud}…`);
      try { await wsPort.open({ baudRate: baud }); }
      catch (e) { addLog('[baud] open: ' + e.message); break; }

      // Fixed baud — no detection needed.
      if (baudVal !== 'auto') { foundBaud = baud; break; }

      // Auto-detect: listen for a MAVLink HEARTBEAT (msg 0) within 2.5 s.
      let tempReader;
      const detected = await new Promise(resolve => {
        const tid = setTimeout(() => resolve(false), 2500);
        const parser = new MAVParser(id => {
          if (id === 0) { clearTimeout(tid); resolve(true); }
        });
        tempReader = wsPort.readable.getReader();
        (async () => {
          try {
            while (true) {
              const { value, done } = await tempReader.read();
              if (done || !value) break;
              parser.push(value);
            }
          } catch { /* cancelled or closed */ }
        })();
      });

      // Release the temp reader before closing / continuing.
      try { await tempReader.cancel();  } catch {}
      try { tempReader.releaseLock();   } catch {}

      if (detected) {
        foundBaud = baud;
        addLog(`[baud] Heartbeat detected at ${baud} baud`);
        break;
      }

      try { await wsPort.close(); } catch {}
      await new Promise(r => setTimeout(r, 120));
    }

    if (!foundBaud) {
      addLog('[baud] Auto-detect failed — pick a baud rate manually and retry');
      try { await wsPort.close(); } catch {}
      return;
    }

    // ── Port is now open at foundBaud.  Wire up persistent I/O. ─────────────
    port = wsPort;

    const wsWriter = wsPort.writable.getWriter();
    writer = {
      write:       d  => wsWriter.write(d),
      releaseLock: () => { try { wsWriter.releaseLock(); } catch {} }
    };
    reader = wsPort.readable.getReader();

    // Physical unplug safety-net (fires before readLoop's catch)
    wsPort.addEventListener('disconnect', () => {
      if (port === wsPort) {
        port = null; writer = null; reader = null;
        setConnected(false);
        addLog('[usb] Device unplugged');
        removeDroneMarker();
      }
    });

    setConnected(true);
    addLog(`[usb] Web Serial connected at ${foundBaud} baud — waiting for heartbeat`);
    readLoop(new MAVParser(onMessage));
  }

  // ─── Electron IPC serial connection ──────────────────────────────────────
  async function connectIPC () {
    const s = window.electronBridge?.serial;
    if (!s) { addLog('[usb] Not running in Electron — serial not available'); return; }

    addLog('[usb] Scanning for serial ports…');
    const { ports = [], error } = await s.list().catch(e => ({ ports: [], error: e.message }));

    const selectedPath = await window.showSerialPortPicker(ports, error);
    if (!selectedPath) return; // user cancelled

    const baudVal = document.getElementById('serial-baud')?.value ?? '115200';
    let baud;

    s.removeListeners();
    if (baudVal === 'auto') {
      addLog(`[usb] Auto-detecting baud on ${selectedPath}…`);
      baud = await detectBaud(s, selectedPath);
      if (!baud) return;
      s.removeListeners(); // clear temp listeners from detectBaud; port stays open
    } else {
      baud = parseInt(baudVal, 10);
      addLog(`[usb] Connecting to ${selectedPath} at ${baud} baud…`);
      try { await s.open(selectedPath, baud); } catch (e) { addLog('[usb] ' + e); return; }
    }

    // IPC writer — same interface as Web Serial WritableStreamDefaultWriter
    writer = {
      write:       (data) => { s.write(Array.from(data)); return Promise.resolve(); },
      releaseLock: () => {},
    };
    // IPC reader — only cancel() is used (by disconnect)
    reader = {
      cancel:      async () => { try { await s.close(); } catch {} },
      releaseLock: () => {},
    };

    const parser = new MAVParser(onMessage);
    s.onData(buf  => parser.push(buf));
    s.onError(msg => addLog('[usb] Error: ' + msg));
    s.onClose(()  => {
      if (writer) { writer = null; reader = null; setConnected(false); addLog('[usb] Port closed'); }
    });

    setConnected(true);
    addLog(`[usb] Connected to ${selectedPath} at ${baud} baud — waiting for heartbeat`);
  }

  // ─── Connection management ────────────────────────────────────────────────
  async function connect () {
    const mode = document.getElementById('conn-mode')?.value ?? 'usb';

    // ── WiFi / WebSocket backpack path ──────────────────────────────────────
    if (mode === 'wifi' || mode === 'direct') {
      if (wsConn) { await disconnect(); return; }
      const url = document.getElementById('wifi-url')?.value?.trim() || 'ws://192.168.4.1:14550';
      if (mode === 'wifi' && window.electronBridge) {
        const backpackIp = document.getElementById('backpack-ip')?.value?.trim() || '10.0.0.1';
        window.electronBridge.startBridge({ mode: 'udp', backpackIp });
      }
      // Store for auto-reconnect
      _wifiUrl               = url;
      _wifiMode              = mode;
      _wifiIntentional       = false;
      _wifiReconnectAttempts = 0;
      clearTimeout(_wifiReconnectTimer);
      _openWifiSocket(url);
      return;
    }

    // ── USB / Serial path ────────────────────────────────────────────────────
    // Electron: full port list + native baud detection via serialport package.
    // Browser:  Web Serial API (Chrome / Edge 89+) — native OS port-picker.
    if (writer) { await disconnect(); return; }
    if (window.electronBridge?.serial) {
      await connectIPC();
    } else {
      await connectWebSerial();
    }
  }

  function _openWifiSocket (url) {
    try {
      const ws     = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const parser  = new MAVParser(onMessage);

      ws.onopen = () => {
        // Guard: if another socket beat us to it, close this one
        if (wsConn && wsConn !== ws) { try { ws.close(); } catch {} return; }
        wsConn  = ws;
        writer  = { write: (d) => { ws.send(d); return Promise.resolve(); } };
        _wifiReconnectAttempts = 0;
        clearTimeout(_wifiReconnectTimer);
        setConnected(true);
        addLog('Wireless connected · ' + url);
      };

      ws.onmessage = (e) => parser.push(new Uint8Array(e.data));

      ws.onerror = () => {
        // Only log if this is the current socket (avoids noise from stale ones)
        if (wsConn === ws || wsConn === null) {
          addLog('[wifi] Connection failed — check URL / backpack AP');
        }
      };

      ws.onclose = () => {
        // CRITICAL: check this specific socket instance to avoid a race condition
        // where a new socket opens before the old one's onclose fires, causing
        // the new connection's state to be wiped.
        if (wsConn !== ws) return;
        clearTimeout(_hbWatchdog);
        wsConn = null; writer = null;
        setConnected(false);
        if (_wifiIntentional) {
          addLog('Wireless disconnected');
        } else {
          addLog('Wireless disconnected unexpectedly — reconnecting…');
          _scheduleWifiReconnect();
        }
      };
    } catch (e) {
      addLog('[wifi] ' + e.message);
      _scheduleWifiReconnect();
    }
  }

  function _scheduleWifiReconnect () {
    if (_wifiIntentional || !_wifiUrl) return;
    if (_wifiReconnectAttempts >= WIFI_MAX_ATTEMPTS) {
      addLog('[wifi] Giving up after ' + WIFI_MAX_ATTEMPTS + ' attempts — click Connect to retry');
      return;
    }
    const delay = WIFI_BACKOFF_MS[_wifiReconnectAttempts] ?? 30000;
    _wifiReconnectAttempts++;
    addLog(`[wifi] Reconnect attempt ${_wifiReconnectAttempts}/${WIFI_MAX_ATTEMPTS} in ${delay / 1000}s…`);
    _wifiReconnectTimer = setTimeout(() => {
      if (_wifiIntentional || wsConn) return;
      _openWifiSocket(_wifiUrl);
    }, delay);
  }

  async function disconnect () {
    // Mark as intentional so the onclose handler doesn't trigger auto-reconnect
    _wifiIntentional = true;
    clearTimeout(_wifiReconnectTimer);
    clearTimeout(_hbWatchdog);
    if (wsConn) {
      const ws = wsConn; wsConn = null;
      try { ws.close(); } catch {}
      writer = null;
    } else {
      window.electronBridge?.serial?.removeListeners();
      try { await reader?.cancel(); }   catch {}
      try { writer?.releaseLock(); }    catch {}
      try { await port?.close(); }      catch {}
      port = null; writer = null; reader = null;
    }
    flightStartTime = null;
    setConnected(false);
    addLog('Disconnected');
  }

  let _heartbeatTimer = null;

  function setConnected (on) {
    const btn = document.getElementById('serial-connect-btn');
    if (btn) {
      btn.textContent = on ? 'Disconnect' : 'Connect';
      btn.dataset.on  = on ? '1' : '0';
    }
    const badge = document.getElementById('serial-status');
    if (badge) {
      badge.textContent  = on ? '● Connected' : '○ Disconnected';
      badge.dataset.conn = on ? '1' : '0';
    }
    const upBtn = document.getElementById('upload-btn');
    if (upBtn) upBtn.disabled = !on;
    const fetchBtn = document.getElementById('bb-fetch-list-btn');
    if (fetchBtn) fetchBtn.disabled = !on;
    const gcsConnBtn = document.getElementById('gcs-connect-btn');
    if (gcsConnBtn) { gcsConnBtn.textContent = on ? 'Disconnect FC' : 'Connect to FC'; gcsConnBtn.className = on ? 'btn danger' : 'btn primary'; gcsConnBtn.style.cssText = 'width:100%;font-size:13px;padding:10px'; }

    // ── Heartbeat keepalive ───────────────────────────────────────────────
    // ArduPilot stops streaming LOG_DATA if no GCS heartbeat arrives within 3 s.
    // We also need it for general MAVLink compliance (FC uses it to detect GCS).
    // Send one immediately on connect so the FC sees us as an active GCS even
    // if the user triggers a log download before the first interval fires.
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
    if (on) {
      writer?.write(buildHeartbeat()).catch(() => {});
      _heartbeatTimer = setInterval(() => {
        // Rebuild each time so every frame gets a fresh sequence number
        writer?.write(buildHeartbeat()).catch(() => {});
      }, 1000);
    }

    if (!on) {
      // Abort any in-progress log transfer cleanly
      if (logListState) {
        clearTimeout(logListState.timer);
        logListState.resolve([]);
        logListState = null;
      }
      if (logDownState) {
        clearTimeout(logDownState.overallTimer);
        clearTimeout(logDownState.chunkTimer);
        logDownState.resolve(null);
        logDownState = null;
      }
      // Clear telemetry display, live map marker, and altitude track when disconnected.
      removeDroneMarker();
      Object.keys(tele).forEach(k => delete tele[k]);
      liveAltLog = [];
      renderTele();
      // Remove Live dataset from profile chart so stale data doesn't persist
      window._refreshLiveAltOverlay?.();
      setUploadStatus('', '');
    }
  }

  // ─── Waypoint upload ──────────────────────────────────────────────────────
  async function uploadWaypoints () {
    if (!writer) { addLog('[upload] Not connected'); return; }

    // waypoints and homeLat/Lon are `let` in the main script — not on window.
    // The main script registers bridge closures to expose them.
    const wps = window._serialGetWaypoints?.() ?? [];
    if (!wps.length) { addLog('[upload] No waypoints defined'); return; }

    const home = window._serialGetHome?.() ?? { lat: wps[0].lat, lon: wps[0].lon };
    const hLat = home.lat, hLon = home.lon;
    const funcBlocks = window._serialGetFuncBlocks?.() ?? [];
    // Expand: nav item first, then photo digicam, then speed-block DO_CHANGE_SPEED, then post-action DO/CONDITION.
    const list = [{ lat: hLat, lon: hLon, alt: 0, action: 'home' }];
    for (let wpIdx = 0; wpIdx < wps.length; wpIdx++) {
      const wp = wps[wpIdx];
      list.push(wp);
      if (wp.action === 'photo') list.push({ lat: 0, lon: 0, alt: 0, action: '_digicam' });
      // Auto-inject DO_CHANGE_SPEED for WPs covered by a set_speed func block
      if (wp.preAction !== 'set_speed') {
        const speedBlk = funcBlocks.find(b => b.type === 'set_speed' && b.startWpIdx <= wpIdx && b.endWpIdx >= wpIdx);
        if (speedBlk) {
          list.push({ lat: 0, lon: 0, alt: 0, action: 'set_speed', speedType: 1, speed: parseFloat(speedBlk.params.speed) || 15 });
        }
      }
      if (wp.preAction && wp.preAction !== 'none') {
        // Synthetic item: carries post-action type + all params from the parent wp
        list.push({ ...wp, action: wp.preAction });
      }
    }

    const tSys  = parseInt(document.getElementById('serial-sysid')?.value  ?? '1', 10);
    const tComp = parseInt(document.getElementById('serial-compid')?.value ?? '1', 10);

    let resolveUp, rejectUp;
    const promise = new Promise((res, rej) => { resolveUp = res; rejectUp = rej; });

    uploadState = { wps: list, tSys, tComp, resolve: resolveUp, reject: rejectUp };

    // Kick off the upload by sending MISSION_COUNT.
    try {
      await writer.write(buildMissionCount(list.length, tSys, tComp));
      addLog(`[upload] MISSION_COUNT=${list.length} sent to sysid=${tSys}`);
      setUploadStatus('Waiting for FC…', 'info');
    } catch (e) {
      uploadState = null;
      addLog('[upload] Write failed: ' + e.message);
      return;
    }

    // Timeout guard: 15 s.
    const tid = setTimeout(() => {
      if (uploadState) {
        uploadState = null;
        setUploadStatus('Upload timed out', 'err');
        rejectUp(new Error('timeout'));
      }
    }, 15000);

    try {
      await promise;
    } catch (e) {
      addLog('[upload] Failed: ' + e.message);
    } finally {
      clearTimeout(tid);
    }
  }

  // ─── Export telemetry CSV ─────────────────────────────────────────────────
  function exportTelCSV () {
    if (!telLog.length) { addLog('[export] No telemetry data yet'); return; }
    const header = 'time,lat,lon,alt_rel,alt_msl,hdg,roll,pitch,yaw,airspeed,gndspeed,climb,throttle,voltage,batt_pct,gps_fix,sats';
    const csv    = header + '\n' + telLog.join('\n');
    const blob   = new Blob([csv], { type: 'text/csv' });
    const a      = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'blackbox_' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.csv';
    a.click();
    addLog('[export] CSV downloaded (' + telLog.length + ' rows)');
  }

  function clearLog () { telLog = []; }
  function toggleLogPause () {
    logPaused = !logPaused;
    const btn = document.getElementById('tele-pause-btn');
    if (btn) {
      btn.textContent = logPaused ? '▶ Resume Log' : '⏸ Pause Log';
      btn.dataset.paused = logPaused ? '1' : '0';
    }
  }

  // ─── Finish Flight — pause log + pre-fill logbook ────────────────────────
  function finishFlight () {
    // Pause logging
    if (!logPaused) {
      logPaused = true;
      const btn = document.getElementById('tele-pause-btn');
      if (btn) { btn.textContent = '▶ Resume Log'; btn.dataset.paused = '1'; }
    }

    // Duration from first position telemetry to now
    const durationMin = flightStartTime
      ? Math.max(1, Math.round((Date.now() - flightStartTime) / 60000))
      : 15;

    // Open the logbook panel (defined in main script, global scope)
    if (typeof openLogbook === 'function') openLogbook();

    // Pre-fill the entry form with live telemetry
    const dateEl = document.getElementById('log-date');
    if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];

    const locEl = document.getElementById('log-location');
    if (locEl && tele.lat != null && tele.lon != null) {
      locEl.value = `${tele.lat.toFixed(4)}, ${tele.lon.toFixed(4)}`;
    }

    const durEl = document.getElementById('log-duration');
    if (durEl) durEl.value = durationMin;

    const notes = [
      tele.altRel  != null ? `AGL: ${tele.altRel.toFixed(0)} m`   : null,
      tele.gpsSats != null ? `GPS: ${tele.gpsSats} sats`           : null,
      telLog.length        ? `${telLog.length} telemetry rows`      : null,
    ].filter(Boolean).join(' · ');
    const notesEl = document.getElementById('log-notes');
    if (notesEl && notes) notesEl.value = notes;

    const outcomeEl = document.getElementById('log-outcome');
    if (outcomeEl) outcomeEl.value = 'Successful';

    addLog('[flight] Finished — logbook pre-filled (' + durationMin + ' min)');

    // Make the current telemetry log available for the logbook to attach to its entry.
    // The main script reads window._pendingTelLog in addLogEntry() and clears it afterwards.
    window._pendingTelLog = telLog.slice();
  }

  // ─── DataFlash log list + download ───────────────────────────────────────
  async function requestLogList () {
    if (!writer) { addLog('[log] Not connected'); return []; }
    const tSys  = parseInt(document.getElementById('serial-sysid')?.value  ?? '1', 10);
    const tComp = parseInt(document.getElementById('serial-compid')?.value ?? '1', 10);

    return new Promise((resolve) => {
      if (logListState) { clearTimeout(logListState.timer); logListState = null; }
      logListState = {
        entries: [],
        resolve,
        reject: resolve.bind(null, []),
        timer: setTimeout(() => {
          if (logListState) {
            const { entries, resolve: res } = logListState;
            logListState = null;
            addLog('[log] Log list timeout — got ' + entries.length + ' entries');
            res(entries);
          }
        }, 10000)
      };
      writer.write(buildLogRequestList(tSys, tComp)).catch(e => {
        addLog('[log] ' + e.message);
        clearTimeout(logListState?.timer);
        logListState = null;
        resolve([]);
      });
      addLog('[log] Requesting log list from FC…');
    });
  }

  // ArduPilot's LOG_REQUEST_DATA is chunk-by-chunk: the FC sends exactly `count`
  // bytes then calls end_log_transfer() (clearing _log_sending_link).  Any new
  // LOG_REQUEST_DATA sent WHILE _log_sending_link is set is silently rejected.
  // We must wait for the current chunk to finish (detected by highWaterOfs reaching
  // chunkEnd) before issuing the next request.  CHUNK_SIZE is 100 × 90 = 9000 bytes
  // so each chunk is exactly 100 MAVLink packets (no short-packet ambiguity on chunk
  // boundaries — short packets only appear at true end-of-file).
  const CHUNK_SIZE = 90 * 100; // 9000 bytes

  // ── Wireless-aware timing constants ─────────────────────────────────────────
  // WiFi/backpack links have higher latency and packet loss than USB serial.
  // LOG_REQUEST_END must reach the FC and clear _log_sending_link BEFORE
  // LOG_REQUEST_DATA arrives, or ArduPilot silently drops the request.
  // We re-send LOG_REQUEST_END multiple times to survive packet loss (WiFi)
  // or a stale lock left from a previous session (cable).
  function isWifi () { return !!wsConn; }
  const STALL_MS      = () => isWifi() ? 12000 : 6000; // stall detection window
  const PRE_REQ_MS    = () => isWifi() ?   900 :  500; // delay after LOG_REQUEST_END
  const END_REPEATS   = () => isWifi() ?     3 :    2; // how many times to send END
  const END_REPEAT_MS = 200; // interval between repeated END frames

  // Send LOG_REQUEST_END `n` times (200 ms apart) then call `cb` after PRE_REQ_MS.
  function clearLockThenDo (tSys, tComp, cb) {
    const n = END_REPEATS();
    let i = 0;
    function sendOne () {
      if (!logDownState && cb !== null) return; // cancelled mid-sequence
      writer?.write(buildLogRequestEnd(tSys, tComp)).catch(() => {});
      i++;
      if (i < n) {
        setTimeout(sendOne, END_REPEAT_MS);
      } else {
        setTimeout(() => { if (logDownState || cb === null) cb?.(); }, PRE_REQ_MS());
      }
    }
    sendOne();
  }

  async function downloadLog (logId, totalSize) {
    if (!writer) { addLog('[log] Not connected'); return null; }
    const tSys  = parseInt(document.getElementById('serial-sysid')?.value  ?? '1', 10);
    const tComp = parseInt(document.getElementById('serial-compid')?.value ?? '1', 10);

    // Abort any previous in-flight download
    if (logDownState) {
      clearTimeout(logDownState.overallTimer);
      clearTimeout(logDownState.chunkTimer);
      logDownState = null;
    }

    return new Promise((resolve) => {
      const buf = new Uint8Array(totalSize);
      // Overall safety net: ~3 s per chunk + 60 s headroom (more for WiFi)
      const overallTimeout = Math.max(120000, Math.ceil(totalSize / CHUNK_SIZE) * (isWifi() ? 15000 : 3000) + 60000);

      logDownState = {
        buf, totalSize, logId,
        highWaterOfs: 0,
        chunkOfs:     0,
        chunkEnd:     Math.min(CHUNK_SIZE, totalSize),
        lastDataAt:   Date.now(),
        tSys, tComp,
        retryCount:   0,
        chunkTimer:   null,
        overallTimer: setTimeout(() => {
          if (!logDownState) return;
          addLog('[log] Download timed out — returning partial data');
          const { buf: b, resolve: res } = logDownState;
          clearTimeout(logDownState.chunkTimer);
          logDownState = null;
          res(b);
        }, overallTimeout),
        resolve,
        sendChunk: null // filled in below
      };

      function scheduleChunkStallTimer () {
        clearTimeout(logDownState?.chunkTimer);
        if (!logDownState) return;
        logDownState.chunkTimer = setTimeout(() => {
          if (!logDownState) return;
          // Still flowing — just extend the window.
          if (Date.now() - logDownState.lastDataAt < STALL_MS() - 500) {
            scheduleChunkStallTimer();
            return;
          }
          const hw = logDownState.highWaterOfs;
          logDownState.retryCount++;
          const partial = hw > 0
            ? ` (${hw} bytes received, stalled before chunkEnd=${logDownState.chunkEnd})`
            : ' (no LOG_DATA received — FC may have ignored request)';
          addLog(`[log] Chunk stall at ofs=${logDownState.chunkOfs}${partial} — retry #${logDownState.retryCount}`);

          // Clear the FC lock, then re-request the same chunk.
          // Also re-send LOG_REQUEST_DATA 2 s later if still silent (covers the case
          // where the FC accepted the lock-clear but the first DATA packet was missed).
          clearLockThenDo(logDownState.tSys, logDownState.tComp, () => {
            if (!logDownState) return;
            logDownState.lastDataAt = Date.now();
            logDownState.sendChunk();
            setTimeout(() => {
              if (!logDownState || logDownState.highWaterOfs > hw) return;
              addLog('[log] Re-sending LOG_REQUEST_DATA (still no response after 2 s)');
              logDownState.sendChunk();
            }, 2000);
          });
        }, STALL_MS());
      }

      function sendChunk () {
        if (!logDownState) return;
        const { chunkOfs, totalSize: ts, tSys: s, tComp: c, logId: id } = logDownState;
        const count = Math.min(CHUNK_SIZE, ts - chunkOfs);
        addLog(`[log] → LOG_REQUEST_DATA id=${id} ofs=${chunkOfs} count=${count} tSys=${s} tComp=${c}`);
        writer.write(buildLogRequestData(id, chunkOfs, count, s, c)).catch(e => {
          addLog('[log] write: ' + e.message);
        });
        scheduleChunkStallTimer();
      }

      logDownState.sendChunk = sendChunk;

      // Clear any stale FC lock before the first chunk, then start the download.
      const connType = isWifi() ? 'wireless' : 'serial';
      addLog(`[log] Clearing FC lock (${connType}), then downloading log id=${logId} (${(totalSize / 1024).toFixed(1)} KB)…`);
      clearLockThenDo(tSys, tComp, () => {
        if (!logDownState) return;
        addLog(`[log] Downloading log id=${logId} (${(totalSize / 1024).toFixed(1)} KB) — chunk-based`);
        sendChunk();
      });
    });
  }

  function cancelLogDownload () {
    if (!logDownState) return;
    clearTimeout(logDownState.overallTimer);
    clearTimeout(logDownState.chunkTimer);
    const res = logDownState.resolve;
    logDownState = null;
    addLog('[log] Download cancelled by user');
    res(null);
  }

  // ─── Expose to global scope ───────────────────────────────────────────────
  window.serialConnect          = connect;
  window.serialDisconnect       = disconnect;
  window.serialUploadWaypoints  = uploadWaypoints;
  // ─── Flight control commands ──────────────────────────────────────────────
  window.serialSetMode = (customMode) => {
    if (!writer) { addLog('[mode] Not connected'); return; }
    const tSys  = parseInt(document.getElementById('serial-sysid')?.value  ?? '1', 10);
    const tComp = parseInt(document.getElementById('serial-compid')?.value ?? '1', 10);

    // Send both SET_MODE (msg 11, legacy) and COMMAND_LONG MAV_CMD_DO_SET_MODE (176,
    // preferred by newer ArduPilot). Also retry 3× at 200 ms / 500 ms because
    // MAVLink over WiFi drops packets and the FC silently ignores duplicates.
    const sendOnce = () => {
      if (!writer) return;
      writer.write(buildSetMode(customMode, tSys)).catch(e => addLog('[mode] SET_MODE: ' + e.message));
      writer.write(buildCommandLong(tSys, tComp, 176, 1, customMode, 0, 0, 0, 0, 0, 0))
            .catch(e => addLog('[mode] DO_SET_MODE: ' + e.message));
    };

    sendOnce();
    setTimeout(sendOnce, 200);
    setTimeout(sendOnce, 500);
    addLog(`[mode] SET_MODE + DO_SET_MODE custom_mode=${customMode} → sysid=${tSys} (×3)`);
  };

  window.serialArmDisarm = (arm) => {
    if (!writer) { addLog('[arm] Not connected'); return; }
    const tSys  = parseInt(document.getElementById('serial-sysid')?.value  ?? '1', 10);
    const tComp = parseInt(document.getElementById('serial-compid')?.value ?? '1', 10);
    writer.write(buildCommandLong(tSys, tComp, 400, arm ? 1 : 0, 0, 0, 0, 0, 0, 0, 0)).catch(e => addLog('[arm] ' + e.message));
    addLog(`[arm] COMMAND_LONG ARM_DISARM param1=${arm ? 1 : 0} → sysid=${tSys}`);
  };

  // ─── RC_CHANNELS_OVERRIDE — joystick control ──────────────────────────────
  // chs: array of 8 channel values (1000–2000 µs). Use 65535 to release a channel.
  // Call at ~20 Hz while joystick override is active; call with all 65535 to release.
  window.serialSendRC = (chs) => {
    if (!writer) return;
    const tSys  = parseInt(document.getElementById('serial-sysid')?.value  ?? '1', 10);
    const tComp = parseInt(document.getElementById('serial-compid')?.value ?? '1', 10);
    const [c1=65535,c2=65535,c3=65535,c4=65535,c5=65535,c6=65535,c7=65535,c8=65535] = chs;
    writer.write(buildRCOverride(tSys, tComp, c1, c2, c3, c4, c5, c6, c7, c8))
          .catch(() => {});
  };

  window.serialExportCSV        = exportTelCSV;
  window.serialClearLog         = clearLog;
  window.serialToggleLogPause   = toggleLogPause;
  window.serialFinishFlight     = finishFlight;
  // Allow external callers to inspect the current live log
  window.serialGetTelLog        = () => telLog.slice();
  // DataFlash log download via USB/serial
  window.serialRequestLogList   = requestLogList;
  window.serialDownloadLog      = downloadLog;
  window.serialCancelLogDownload = cancelLogDownload;

})();
