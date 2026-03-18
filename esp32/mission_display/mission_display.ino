/*
 * AeroNav Mission Display — ESP32-S3-WROOM-1 + GC9A01 round 240×240 TFT
 *
 * Shows the active mission route + live plane dot, mirroring the
 * Mission Thumbnail Gallery overlay in the AeroNav desktop app.
 *
 * Required Arduino libraries (install via Library Manager):
 *   • TFT_eSPI       by Bodmer
 *   • WebSockets     by Markus Sattler (arduinoWebSockets)
 *   • ArduinoJson    by Benoit Blanchon  (v6 or v7)
 *
 * After installing TFT_eSPI, copy User_Setup.h from this folder into
 * the TFT_eSPI library directory (overwrite the existing one).
 *
 * Wiring summary (see User_Setup.h for full pin list):
 *   GND → GND | VCC → 3.3 V | SCL → 12 | SDA → 11
 *   RES → 8   | DC  → 9    | CS  → 10  | BLK → 46
 *
 * The AeroNav app broadcasts JSON on port 5763 (all network interfaces).
 * Your PC and ESP32 must be on the same WiFi network.
 */

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <TFT_eSPI.h>
#include <math.h>

// ── Configuration — edit these ────────────────────────────────────────────────
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char* WS_HOST   = "192.168.1.100";   // LAN IP of the PC running AeroNav
const int   WS_PORT   = 5763;
const int   BL_PIN    = 46;                // backlight GPIO
// ─────────────────────────────────────────────────────────────────────────────

TFT_eSPI     tft = TFT_eSPI();
WebSocketsClient ws;

// ── Scene data ────────────────────────────────────────────────────────────────
struct WP { float lat, lon; };
static WP    wps[64];
static int   wpCount  = 0;
static float homeLat  = 0, homeLon  = 0;
static float planeLat = 0, planeLon = 0, planeHdg = 0;
static bool  hasData  = false;
static bool  dirty    = true;

// ── Projection ────────────────────────────────────────────────────────────────
struct Proj { float minLon, maxLat, scale, offX, offY; bool valid; };

static Proj computeProjection() {
  Proj p = {0, 0, 1, 0, 0, false};
  if (wpCount == 0) return p;

  const float PAD = 20.0f;
  const float W = 240.0f, H = 240.0f;

  float minLat = wps[0].lat, maxLat = wps[0].lat;
  float minLon = wps[0].lon, maxLon = wps[0].lon;
  for (int i = 1; i < wpCount; i++) {
    minLat = min(minLat, wps[i].lat); maxLat = max(maxLat, wps[i].lat);
    minLon = min(minLon, wps[i].lon); maxLon = max(maxLon, wps[i].lon);
  }
  // Include home position in bounds
  minLat = min(minLat, homeLat); maxLat = max(maxLat, homeLat);
  minLon = min(minLon, homeLon); maxLon = max(maxLon, homeLon);

  float spanLat = maxLat - minLat; if (spanLat < 0.0001f) spanLat = 0.0001f;
  float spanLon = maxLon - minLon; if (spanLon < 0.0001f) spanLon = 0.0001f;

  float bw = W - PAD * 2.0f, bh = H - PAD * 2.0f;
  float scale = min(bw / spanLon, bh / spanLat);

  p.minLon = minLon;
  p.maxLat = maxLat;
  p.scale  = scale;
  p.offX   = PAD + (bw - spanLon * scale) / 2.0f;
  p.offY   = PAD + (bh - spanLat * scale) / 2.0f;
  p.valid  = true;
  return p;
}

static inline int tx(const Proj& p, float lon) {
  return (int)(p.offX + (lon - p.minLon) * p.scale);
}
static inline int ty(const Proj& p, float lat) {
  return (int)(p.offY + (p.maxLat - lat) * p.scale);
}

// ── Draw the full scene onto the display ─────────────────────────────────────
void drawScene() {
  tft.fillScreen(TFT_BLACK);

  if (!hasData || wpCount < 2) {
    tft.setTextColor(TFT_DARKGREY, TFT_BLACK);
    tft.drawString("Waiting for mission...", 20, 110, 2);
    return;
  }

  Proj proj = computeProjection();
  if (!proj.valid) return;

  // Route line (blue)
  for (int i = 1; i < wpCount; i++) {
    tft.drawLine(tx(proj, wps[i-1].lon), ty(proj, wps[i-1].lat),
                 tx(proj, wps[i].lon),   ty(proj, wps[i].lat),
                 0x5AFF);   // #58a6ff approximated in RGB565
  }

  // Waypoint dots (blue)
  for (int i = 0; i < wpCount; i++) {
    tft.fillCircle(tx(proj, wps[i].lon), ty(proj, wps[i].lat), 4, 0x5AFF);
  }

  // Home dot (green, slightly larger)
  if (homeLat != 0.0f || homeLon != 0.0f) {
    tft.fillCircle(tx(proj, homeLon), ty(proj, homeLat), 6, TFT_GREEN);
    tft.drawCircle(tx(proj, homeLon), ty(proj, homeLat), 6, TFT_BLACK);
  }

  // Plane arrow — same chevron shape as the in-app overlay, scaled for 240 px.
  float px = proj.offX + (planeLon - proj.minLon) * proj.scale;
  float py = proj.offY + (proj.maxLat - planeLat) * proj.scale;

  // Keep within the 240×240 circle face (radius 112 from centre)
  float cx = 120.0f, cy = 120.0f;
  float dx = px - cx, dy = py - cy;
  if (px >= 4 && px < 236 && py >= 4 && py < 236 &&
      (dx*dx + dy*dy) < 112.0f*112.0f) {

    // Arrow shape (pointing north / up before rotation):
    //   tip (0,-12), right-wing (8,9), tail-notch (0,5), left-wing (-8,9)
    const float SX[4] = { 0,  8,  0, -8 };
    const float SY[4] = {-12,  9,  5,  9 };

    // 2D clockwise rotation in screen space (y-down) = standard CCW rotation:
    //   x' = x·cos(hdg) - y·sin(hdg)
    //   y' = x·sin(hdg) + y·cos(hdg)
    float hdgRad = planeHdg * (float)M_PI / 180.0f;
    float cosH = cosf(hdgRad), sinH = sinf(hdgRad);

    float ax[4], ay[4];
    for (int i = 0; i < 4; i++) {
      ax[i] = px + SX[i]*cosH - SY[i]*sinH;
      ay[i] = py + SX[i]*sinH + SY[i]*cosH;
    }

    // Two triangles: (tip, right-wing, tail-notch) and (tip, tail-notch, left-wing)
    tft.fillTriangle((int)ax[0], (int)ay[0],
                     (int)ax[1], (int)ay[1],
                     (int)ax[2], (int)ay[2], TFT_GREEN);
    tft.fillTriangle((int)ax[0], (int)ay[0],
                     (int)ax[2], (int)ay[2],
                     (int)ax[3], (int)ay[3], TFT_GREEN);
    // Dark outline (draws the outer chevron edge)
    tft.drawLine((int)ax[0], (int)ay[0], (int)ax[1], (int)ay[1], TFT_BLACK);
    tft.drawLine((int)ax[0], (int)ay[0], (int)ax[3], (int)ay[3], TFT_BLACK);
    tft.drawLine((int)ax[1], (int)ay[1], (int)ax[2], (int)ay[2], TFT_BLACK);
    tft.drawLine((int)ax[3], (int)ay[3], (int)ax[2], (int)ay[2], TFT_BLACK);
  }
}

// ── WebSocket event handler ───────────────────────────────────────────────────
void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[ws] Connected to AeroNav");
      dirty = true;
      break;

    case WStype_DISCONNECTED:
      Serial.println("[ws] Disconnected — reconnecting...");
      break;

    case WStype_TEXT: {
      // Parse JSON: { waypoints:[{lat,lon},...], home:{lat,lon}, plane:{lat,lon,hdg} }
      JsonDocument doc;
      if (deserializeJson(doc, payload, length)) return;

      JsonArray arr = doc["waypoints"].as<JsonArray>();
      wpCount = 0;
      for (JsonObject wp : arr) {
        if (wpCount >= (int)(sizeof(wps)/sizeof(wps[0]))) break;
        wps[wpCount].lat = wp["lat"].as<float>();
        wps[wpCount].lon = wp["lon"].as<float>();
        wpCount++;
      }

      if (!doc["home"].isNull()) {
        homeLat = doc["home"]["lat"].as<float>();
        homeLon = doc["home"]["lon"].as<float>();
      }
      if (!doc["plane"].isNull()) {
        planeLat = doc["plane"]["lat"].as<float>();
        planeLon = doc["plane"]["lon"].as<float>();
        planeHdg = doc["plane"]["hdg"].as<float>();
      }

      hasData = true;
      dirty   = true;
      break;
    }
    default: break;
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  // Backlight on
  pinMode(BL_PIN, OUTPUT);
  digitalWrite(BL_PIN, HIGH);

  tft.init();
  tft.setRotation(0);
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.drawString("Connecting WiFi...", 30, 108, 2);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (++attempts > 40) {   // 20 s timeout — reboot and retry
      Serial.println("\n[wifi] Timeout — rebooting");
      ESP.restart();
    }
  }
  Serial.println("\n[wifi] Connected: " + WiFi.localIP().toString());

  tft.fillScreen(TFT_BLACK);
  tft.drawString("WiFi OK", 80, 100, 2);
  tft.drawString(WiFi.localIP().toString().c_str(), 40, 120, 2);
  delay(1500);

  ws.begin(WS_HOST, WS_PORT, "/");
  ws.onEvent(webSocketEvent);
  ws.setReconnectInterval(3000);

  tft.fillScreen(TFT_BLACK);
  tft.drawString("Waiting for AeroNav...", 15, 108, 2);
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  ws.loop();
  if (dirty) {
    dirty = false;
    drawScene();
  }
}
