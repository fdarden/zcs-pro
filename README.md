# ZCS PRO

**ZCS PRO by Zoogloea Control System** is a standalone ESPHome liquid-dosing controller for a 12 V peristaltic pump driven by an external MOSFET module. It keeps the pump and weekly schedule local to the ESP32; Home Assistant is optional.

> **Bench-test with WATER, not vinegar.** Disconnect 12 V pump power while flashing and while first verifying GPIO polarity.

## Project files

- `zcs-pro.yaml` — ESPHome configuration, controller logic, entities, safety automations and local schedule
- `secrets.example.yaml` — provisioning template (copy to `secrets.yaml`)
- `includes/zcs_pro.h` — compact 100-event history ring and time/schedule helpers
- `web/zcs-pro.css` and `web/zcs-pro.js` — local, responsive appliance interface; no internet-hosted UI assets

## Hardware and GPIO map

The default `zcs-pro.yaml` pin map below is for the original full-size ESP32.
The ESP32-C3 Super Mini variant uses `supermini-zcs.yaml` and this pin map:

| ESP32-C3 Super Mini pin | Direction | Assignment |
|---|---:|---|
| GPIO4 | Output | MOSFET TRIG/PWM; active HIGH by default |
| GPIO6 | I/O | I²C SDA for optional DS3231 |
| GPIO7 | Output | I²C SCL for optional DS3231 |
| GPIO3 | Input, pull-up | Prime/wake pushbutton to GND |
| GPIO10 | Output | Optional external awake/dose status LED |

GPIO2, GPIO8 and GPIO9 are ESP32-C3 strapping pins and are deliberately unused.
GPIO18 and GPIO19 remain assigned to native USB Serial/JTAG. The optional
status LED is external: connect GPIO10 through a suitable series resistor to
the LED anode and connect the cathode to GND.

| GPIO | Direction | Assignment | v1.0 state |
|---|---:|---|---|
| GPIO23 | Output | MOSFET TRIG/PWM | Active; assumed active HIGH |
| GPIO21 | I/O | I²C SDA for optional DS3231 | Active; RTC may be absent |
| GPIO22 | Output | I²C SCL for optional DS3231 | Active; RTC may be absent |
| GPIO32 | Input, pull-up | Prime pushbutton to GND | Supported; safe non-strapping pin |
| GPIO25 | Output | Reserved for future status LED | Not configured/driven |
| GPIO33 | Input | Suggested future reservoir sensor | Not configured/read |
| GPIO27 | Input | Suggested future flow sensor | Not configured/read |

GPIO32 is not an ESP32 boot-strapping pin. The button is wired between GPIO32 and GND and uses the ESP32 internal pull-up. A short press deliberately does nothing. Holding it for the configured `prime_button_hold` interval (3 seconds by default in the YAML substitutions) starts one timed Prime run. It does not provide a reset gesture.

### Pump and MOSFET wiring

```text
ESP32 GPIO23  -> MOSFET TRIG/PWM
ESP32 GND     -> MOSFET control GND

12 V supply + -> MOSFET VIN+
12 V supply - -> MOSFET VIN-

MOSFET VOUT+  -> pump +
MOSFET VOUT-  -> pump -
```

The ESP32 is powered separately from regulated 5 V. Never connect 12 V to an ESP32 power pin. Confirm from the MOSFET module documentation whether control GND and VIN- are internally common and wire the control reference as the module requires.

Install the flyback diode directly across the pump motor terminals:

```text
pump + ----|<|---- pump -
           diode
```

The diode's **striped cathode goes to pump +** and its anode goes to pump -. It is reverse-biased during normal operation and conducts the motor's inductive kick when switched off. Confirm its current/voltage ratings suit the pump.

For the safest reset behavior, add a physical **10 kΩ pull-down from MOSFET TRIG/GPIO23 to control GND**. Firmware preloads GPIO23 LOW before enabling it as an output and commands it OFF again before network startup, but a resistor also defines the signal during the silicon reset interval before any firmware can run.

The configuration assumes an active-HIGH MOSFET trigger. If bench measurement proves the module active LOW, change only:

```yaml
substitutions:
  pump_inverted: "true"
```

Do not connect the pump until the inactive level has been measured and verified.

### Optional DS3231 wiring

```text
ESP32 GPIO21 -> DS3231 SDA
ESP32 GPIO22 -> DS3231 SCL
ESP32 3.3 V  -> DS3231 VCC
ESP32 GND    -> DS3231 GND
```

The DS3231 is addressed at `0x68` using ESPHome's DS1307-compatible time component. The clock registers are compatible for the operations used here. Power the module at 3.3 V so any onboard I²C pull-ups do not pull ESP32 pins to 5 V. Verify the exact breakout, battery type and charging circuit before installing a coin cell.

An absent RTC is expected during initial development. The RTC component marks only itself failed, the UI reports **RTC: Not Installed**, and Wi-Fi, web control, Home Assistant and manual dosing continue normally.

## Safety architecture

`pump_request` is the only script that can energize GPIO23. Timed buttons, volume buttons, calibration, Prime, the physical button, the local schedule and Home Assistant API actions all route through it. It runs in `single` mode so a second run cannot overlap the active run.

Safety behavior:

- GPIO23 is preloaded to its inactive level at boot priority 1000, then explicitly turned OFF again at hardware priority 800.
- The GPIO output is not exposed as a switch, so there is no unrestricted continuous ON control.
- `pump_request` rejects zero/negative time, time above the configured maximum, and anything above the absolute 120-second cap.
- A separate 250 ms watchdog monitors every active run and forces GPIO23 OFF if the configured/absolute limit is exceeded.
- STOP first writes OFF, then cancels the active pump script, accounts for the partial run and clears active state.
- OTA begin, reboot, normal shutdown and safe mode explicitly drive the pump OFF wherever ESPHome permits.
- Wi-Fi/API reconnects, NTP/RTC synchronization, restored settings and schedule recalculation contain no pump-ON action.
- `wifi.reboot_timeout` and `api.reboot_timeout` are disabled, so loss of Wi-Fi or Home Assistant does not create periodic reboot cycles.
- Default maximum continuous runtime: 120 seconds.
- Default automatic minimum interval: 10 minutes.
- Maximum daily dose defaults to **0 = not configured**. No mL safety value is invented before calibration.

The daily limit, when nonzero and calibrated, applies to scheduled, manual timed, volume and Prime runs based on calculated volume. Calibration itself is excluded because no trustworthy flow exists yet. STOP always works. Manual dosing and Prime are explicit actions and may run during the automatic lockout; the daily and runtime ceilings still apply. Scheduled requests inside lockout are rejected, logged and never silently retried.

Software cannot control a GPIO before the ESP32 begins executing firmware, cannot compensate for a failed/incorrect MOSFET, and cannot prove liquid moved without a physical flow sensor. Use the recommended TRIG pull-down and complete the bench tests before connecting vinegar.

## Timekeeping and weekly schedule

The device uses local wall-clock time and normal DST rules. Set the IANA time-zone name in the `timezone_default` substitution before compiling. ESPHome converts that name to the platform time-zone rule at build time.

Time priority is:

1. On boot, a valid installed RTC seeds system time.
2. When SNTP becomes available, network time corrects system time and is written back to an installed RTC.
3. If neither source yields a sane date from 2024 through 2099, time remains invalid.

With no RTC, scheduling begins after SNTP obtains valid time. With an RTC, the device can reboot and continue scheduled operation without Wi-Fi, Internet or Home Assistant. If time is invalid, schedule execution is inhibited and the interface displays a time fault; manual timed dosing remains available.

One locally persisted schedule supports enable/disable, any combination of weekdays, local hour/minute and mL. It requires calibration and a nonzero dose. The controller checks the slot locally every second and persists the last consumed slot so clock synchronization or recalculation cannot duplicate it.

Missed-dose policy is **SKIP**. At the first valid time after boot, the controller compares the last persisted clock checkpoint with recent schedule slots. The most recent missed slot is written to history as `Missed (skipped)`, the slot is consumed, and the next normal occurrence is calculated. It is never dispensed as catch-up. This path is isolated so a future policy can be added without changing the default.

DST follows ESPHome local-time behavior: a nonexistent spring-forward wall-clock slot is skipped; a duplicated fall-back time is protected from a second dose by the persisted schedule-slot timestamp.

## Persistence and flash wear

ESPHome preferences retain calibration, schedule controls, safety settings, counters, cumulative runtime/volume, daily volume/day key, last attempt/success, automatic lockout timestamps, clock checkpoint and the compact 100-event history ring. Template numbers and switches restore their last state.

Global preference checks and physical flash commits are batched at five-minute intervals; shutdown also asks components to save. The pump is not written to flash every second. A sudden removal of power can therefore lose the newest few minutes of accounting/history, while a normal reboot or OTA follows ESPHome's shutdown-save path. This is the explicit flash-wear tradeoff.

The history stores, where applicable, local date/time, requested/calculated mL, actual runtime, source and result. Sources include Manual, Prime, Home Assistant API actions, Schedule, Calibration, Missed Schedule and Fault/aborted.

## Calibration

1. Fill the source container with **water** and route the outlet into an accurate graduated container.
2. In **Settings → Calibration**, leave the duration at 60 seconds unless there is a safety reason to shorten it.
3. Press **Run Calibration**. The normal central controller and runtime watchdog remain active.
4. Measure the actual collected water.
5. Enter that amount under **Measured volume (mL)**.
6. Press **Save Measurement**.
7. Firmware stores `measured mL / actual calibration runtime` as mL/s and records the date/time if time is valid.
8. Test a small known volume and compare the result before using larger doses.

No calibration constant is supplied. Until a real calibration is saved, volume buttons and scheduling are unavailable, daily-volume accounting reports unavailable, and timed manual runs remain usable.

## Local web interface

Browse to `http://zcs-pro.local/` or the IP address shown by your router/Home Assistant. The bundled interface has Status, Dose, Schedule, Settings and History views; it is responsive for iPhone, iPad and desktop and requires no internet assets. STOP stays prominently above all tabs.

The web interface uses authenticated ESPHome REST entities rather than a second web stack. HTTP Digest authentication is enabled with the separate `web_admin_username` and `web_admin_password` secrets. Keep the device on a trusted LAN/VLAN and never forward port 80 to the internet: HTTP Digest protects the password exchange but does not encrypt page traffic, and ESPHome's web API is not designed as an internet-facing security boundary.

### ESPHome web-auth limitation

ESPHome web-server authentication credentials are compile-time configuration. ESPHome does not provide a safe runtime API for replacing them, so the Settings screen clearly reports that limitation instead of presenting a fake password control. To change the administrator password:

1. Edit `web_admin_password` in `secrets.yaml`.
2. Compile and OTA the same `zcs-pro.yaml`.
3. Sign in with the new password after reboot.

Home Assistant API encryption and OTA credentials are separate secrets. The Home Assistant API row on the authenticated Settings page can reveal and copy the current encryption key after an explicit click. The key is served by a private, no-store endpoint protected by the same web authentication and is not exposed as a Home Assistant entity. The time-zone rule has the same compile-time limitation: edit `timezone_default` and OTA to change it reliably.

## Initial flashing — exact steps

These commands assume ESPHome 2026.7.3 or later and a terminal in this project directory.

1. Leave the 12 V pump supply disconnected. Connect only the ESP32 to USB.
2. Create local secrets:

   ```bash
   cp secrets.example.yaml secrets.yaml
   ```

3. Generate independent credentials and replace every example value:

   ```bash
   openssl rand -base64 32   # API encryption key
   openssl rand -base64 32   # OTA password (use a separate result)
   openssl rand -base64 24   # web password
   openssl rand -base64 12   # fallback AP password
   ```

4. Edit Wi-Fi values in `secrets.yaml`. Edit `timezone_default` near the top of `zcs-pro.yaml` if `America/New_York` is not correct.
5. Install ESPHome using the official method for your system, or use the Home Assistant ESPHome Device Builder add-on.
6. Find the serial port (`/dev/cu.usbserial-*` or `/dev/cu.SLAB_USBtoUART` on macOS; `/dev/ttyUSB0` or `/dev/ttyACM0` on Linux).
7. Validate:

   ```bash
   esphome config zcs-pro.yaml
   ```

8. Compile and flash:

   ```bash
   esphome run zcs-pro.yaml --device /dev/cu.usbserial-XXXX
   ```

9. If automatic bootloader entry fails, hold the board's **BOOT** button, tap **EN/RESET**, start the upload, then release BOOT when writing begins.
10. Watch serial logs until Wi-Fi connects. Open `http://zcs-pro.local/` and sign in with the web-admin secret.

The compile produces `firmware.factory.bin` for serial/full first flash and `firmware.ota.bin` for OTA in `.esphome/build/zcs-pro/build/`.

## Fallback Wi-Fi provisioning

If configured Wi-Fi cannot connect for 90 seconds, the device opens **ZCS PRO Setup** using `fallback_ap_password`. Connect to that AP and follow the captive portal to provide Wi-Fi details. Existing saved credentials are not erased merely because the AP starts. The pump stays OFF during startup/provisioning. A schedule can run while the AP is active only when a valid RTC supplied time after boot and the schedule is otherwise valid.

## Home Assistant

1. Put Home Assistant and the controller on reachable networks.
2. In Home Assistant, go to **Settings → Devices & services → Add Integration → ESPHome**.
3. Enter `zcs-pro.local` (or its IP) and the API encryption key from `secrets.yaml` when requested. You can also open the controller's authenticated **Settings** page and click **Home Assistant API → Reveal key**.
4. Assign the device to an area if desired.

Entities include pump/appliance state, STOP, preset/custom timed runs, Prime, calibrated volume doses, schedule enable/day/time/dose controls, next/last dose, daily/total volume, runtime, Wi-Fi, API, RTC/time, calibration, lockout and faults. The disabled-by-default `Dose History JSON` diagnostic entity contains the local history. Native API actions `run_timed`, `dose_volume`, `prime` and `stop` are also supplied so automations can be logged specifically as Home Assistant sources.

Home Assistant does not execute the weekly schedule and can be offline indefinitely without disabling a valid RTC-backed schedule.

## OTA updates

Keep pump tubing in a safe container during updates.

```bash
esphome run zcs-pro.yaml
```

ESPHome discovers the device and uses the native password-protected OTA platform. The authenticated web OTA platform is also compiled for ESPHome-compatible uploads. At OTA begin, firmware commands GPIO23 OFF, cancels the pump run and clears active state; normal shutdown and boot repeat the OFF action.

## Factory reset and recovery

Factory reset is available only through the authenticated Settings page and requires two browser confirmations plus a 30-second firmware arm window. The normal physical-button long press remains Prime-only.

Factory reset clears ESPHome preferences: calibration, schedule, counters/history, captive-portal Wi-Fi overrides and restored settings. Compile-time secrets/settings remain in firmware, including the YAML Wi-Fi credentials, API key, OTA password and web password. Factory reset is not recoverable.

If normal firmware repeatedly fails, ESPHome safe mode retains networking and OTA recovery while the raw pump GPIO is driven inactive. Reflash the last known-good YAML by USB if network recovery is unavailable.

## Bench-test procedure

Perform tests with the pump outlet secured, **water only**, a multimeter/logic probe and ready access to 12 V power.

1. **Boot with pump disconnected.** Measure GPIO23/MOSFET TRIG through reset and boot. Verify the expected inactive LOW level and `Pump State: OFF`.
2. **Web UI.** Verify authentication, phone/tablet/desktop layout, all five tabs, status refresh and prominent STOP.
3. **Home Assistant.** Add the ESPHome integration and confirm status/control entities and encrypted API connection.
4. **GPIO safe default.** Cycle 5 V power several times with 12 V disconnected. Confirm no active trigger pulse. Install/verify the 10 kΩ TRIG pull-down.
5. **STOP.** Connect 12 V and water. Start a 30-second run, press STOP after a few seconds and confirm immediate motor stop plus a Stopped history record.
6. **5 seconds.** Measure actual ON time and check history/runtime accounting.
7. **15 seconds.** Repeat.
8. **30 seconds.** Repeat.
9. **Maximum runtime.** Set maximum runtime to 10 seconds. Confirm a 15-second request is rejected and a 10-second request cannot run past the limit. Restore 120 seconds afterward.
10. **Reboot while active.** Start 60 seconds and invoke authenticated Reboot. Confirm the pump stops before restart and remains off throughout boot.
11. **Wi-Fi loss/reconnect.** Start no pump. Disable the access point/router, wait for fallback behavior, then restore Wi-Fi. Confirm no pump activation and no duplicate schedule.
12. **Calibration.** Pump water for 60 seconds, measure it, save the measurement and verify the stored mL/s is the measured amount divided by actual runtime.
13. **mL dose.** Request a small known volume, measure it and assess repeatability. Recalibrate if tubing/head conditions changed.
14. **Network-time schedule.** With no RTC, schedule a small dose a few minutes ahead. Verify exactly one run. Power off across another slot; restore later and verify a Missed (skipped) record with no catch-up run.
15. **Install DS3231.** Power down fully, wire the RTC at 3.3 V, boot with network and verify `0x68`, valid RTC and network-corrected status.
16. **Standalone RTC schedule.** After a successful network sync, remove Internet/Wi-Fi, reboot so the RTC seeds time, and verify one small scheduled water dose plus correct next-run calculation.

Also test OTA while active, automatic lockout with adjacent configured occurrences, daily-limit rejection, an uncalibrated volume request, a schedule with no selected days, and invalid/unset time after a no-RTC/no-network cold boot.

## Troubleshooting

- **Pump runs at boot:** disconnect 12 V immediately. Verify MOSFET trigger polarity, set `pump_inverted` correctly, add/inspect the 10 kΩ pull-down, and verify module input thresholds. Do not solve this by guessing.
- **Pump never runs:** verify 12 V at VIN, common control reference, GPIO23 output level, MOSFET input compatibility, pump polarity/current and diode orientation. Test the pump directly only with suitable fused 12 V wiring.
- **RTC says Not Installed:** check 3.3 V, GND, SDA/SCL and look for I²C address `0x68` in logs. The rest of the controller should still operate.
- **RTC installed but invalid:** allow network sync once, then reboot and retest. Check the backup cell and breakout design.
- **Schedule unavailable:** calibration, at least one day, nonzero mL, enabled state and valid local time are all required. Check Faults, lockout and daily-limit status.
- **Volume request rejected for runtime:** requested mL divided by calibrated mL/s exceeds the configured maximum or absolute 120 seconds. Use a higher-flow pump or a smaller single dose; v1.0 does not split a dose into multiple runs.
- **Cannot open `.local`:** use the IP address from the router/Home Assistant; mDNS may not cross VLANs.
- **Cannot sign in after changing secrets:** web credentials change only after the new firmware is flashed. Browser credential caching may require a private window.
- **Fallback AP does not appear:** wait at least 90 seconds after failed Wi-Fi connection and ensure the AP password is valid (8+ characters).

## Future hardware hooks

The UI reports Reservoir and Flow Verification as **Not Installed**—no readings are fabricated. Suggested GPIOs are reserved only in documentation so the initial firmware does not drive or bias unknown hardware.

A reservoir implementation should publish `OK`, `LOW` or `EMPTY` and add an EMPTY check to `pump_request` for scheduled sources (and, if desired, all non-Prime sources). A future positive-flow sensor should measure pulses or liquid movement only while `pump_active` is true, compare detected flow with expected flow after a startup grace period, then use `pump_stop` and record a Fault/aborted event. This preserves the distinction between “motor was powered” and “liquid moved.”

A future single LED on GPIO25 can map Ready, Dosing, Wi-Fi setup and Fault. An RGB implementation can replace that output without changing the controller state model. No LED is required in v1.0.

## Items requiring hardware verification

- MOSFET trigger is actually active HIGH and remains OFF at the measured GPIO23 inactive level
- External TRIG pull-down value/behavior and absence of any reset/boot pulse at the module
- MOSFET input accepts 3.3 V logic and its current/thermal ratings exceed pump startup/stall current
- 12 V supply regulation/current capacity, wiring fuse and common-ground arrangement
- Pump polarity, direction, diode polarity/rating and tubing compatibility with vinegar
- Real flow rate and repeatability with the final tubing height, backpressure and liquid
- DS3231 breakout voltage, I²C pull-ups, battery/charging design and offline accuracy
- GPIO32 button wiring/debounce and the preferred physical hold duration
- Mobile browser behavior on the actual iPhone/iPad versions and LAN topology
- Future reservoir/flow sensor electrical interfaces and failure thresholds

## Validation record

The project was configuration-validated and fully compiled with **ESPHome 2026.7.3**, ESP-IDF **5.5.5**, target `esp32dev`. The resulting application used about 1.01 MB flash image space and 58.6 kB static DRAM in that build. Hardware behavior remains subject to the verification list above.

Official references: [ESPHome web server](https://esphome.io/components/web_server/), [web REST API](https://esphome.io/web-api/), [OTA platforms and hooks](https://esphome.io/components/ota/), [DS1307-compatible RTC time source](https://esphome.io/components/time/ds1307/), [SNTP time](https://esphome.io/components/time/sntp/) and [time/DST behavior](https://esphome.io/components/time/).
