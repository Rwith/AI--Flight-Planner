// TFT_eSPI User_Setup.h for GC9A01 round 240x240 + ESP32-S3-WROOM-1
// Copy this file into your TFT_eSPI library folder (replacing the existing User_Setup.h).

#define GC9A01_DRIVER

#define TFT_WIDTH  240
#define TFT_HEIGHT 240

// --- Wiring (display header → ESP32-S3 GPIO) ---
// GND  → GND
// VCC  → 3.3 V
// SCL  → GPIO 12   (SPI2 CLK)
// SDA  → GPIO 11   (SPI2 MOSI)
// RES  → GPIO 8
// DC   → GPIO 9
// CS   → GPIO 10
// BLK  → GPIO 46   (backlight PWM — or tie to 3.3 V for always-on)

#define TFT_MOSI 11
#define TFT_SCLK 12
#define TFT_CS   10
#define TFT_DC    9
#define TFT_RST   8
// BLK is controlled in firmware via pinMode/analogWrite on GPIO 46.

#define LOAD_GLCD   // built-in 5×7 font

#define SPI_FREQUENCY  40000000   // 40 MHz — safe for short wires; drop to 27 MHz if glitchy
