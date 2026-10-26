(() => {
  "use strict";

  const E = {
    status: ["text_sensor", "Appliance Status"],
    currentTime: ["text_sensor", "Current Time"],
    rtc: ["text_sensor", "RTC Status"],
    rtcReadback: ["text_sensor", "RTC Readback"],
    timeStatus: ["text_sensor", "Time Status"],
    rtcSync: ["text_sensor", "RTC Sync Result"],
    powerStatus: ["text_sensor", "Power Saving Status"],
    wakeReason: ["text_sensor", "Wake Reason"],
    awakeRemaining: ["text_sensor", "Awake Time Remaining"],
    nextPowerWake: ["text_sensor", "Next Power Wake"],
    powerAction: ["text_sensor", "Power Saving Action"],
    pump: ["text_sensor", "Pump State"],
    last: ["text_sensor", "Last Successful Dose"],
    attempted: ["text_sensor", "Last Attempted Dose"],
    next: ["text_sensor", "Next Scheduled Dose"],
    calibration: ["text_sensor", "Calibration Status"],
    faults: ["text_sensor", "Faults"],
    reservoir: ["text_sensor", "Reservoir Status"],
    flowVerify: ["text_sensor", "Flow Verification Status"],
    dailyLimit: ["text_sensor", "Daily Dose Limit Status"],
    lockout: ["text_sensor", "Automatic Dose Lockout"],
    ip: ["text_sensor", "IP Address"],
    ssid: ["text_sensor", "Connected SSID"],
    fw: ["text_sensor", "Firmware Version"],
    timezone: ["text_sensor", "Configured Time Zone"],
    history: ["text_sensor", "Dose History JSON"],
    api: ["binary_sensor", "Home Assistant API Connected"],
    today: ["sensor", "Amount Dispensed Today"],
    totalVolume: ["sensor", "Total Estimated Volume"],
    totalRuntime: ["sensor", "Total Pump Runtime"],
    wifi: ["sensor", "Wi-Fi Signal"],
    scheduleEnabled: ["switch", "Schedule Enabled"],
    powerSaving: ["switch", "Power Saving Enabled"],
    scheduleHour: ["number", "Schedule Hour"],
    scheduleMinute: ["number", "Schedule Minute"],
    scheduleDose: ["number", "Schedule Dose Volume"],
    maxRuntime: ["number", "Maximum Continuous Runtime"],
    minInterval: ["number", "Automatic Dose Minimum Interval"],
    maxDaily: ["number", "Maximum Daily Dose"],
    customTimed: ["number", "Custom Timed Run"],
    customDose: ["number", "Custom Dose Volume"],
    primeDuration: ["number", "Prime Duration"],
    calibrationDuration: ["number", "Calibration Duration"],
    calibrationMeasured: ["number", "Calibration Measured Volume"],
  };

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  days.forEach((day) => { E[`day${day}`] = ["switch", `Schedule ${day}`]; });
  const cache = {};
  let online = true;
  let activePage = "status";
  let apiKey = "";
  let apiKeyVisible = false;
  let refreshTimer = 0;
  let refreshInFlight = false;
  let refreshQueued = false;

  const path = (type, name, action = "") =>
    `/${type}/${encodeURIComponent(name)}${action ? `/${action}` : ""}`;

  async function getEntity(key) {
    const [type, name] = E[key];
    const response = await fetch(path(type, name), { cache: "no-store" });
    if (!response.ok) throw new Error(`${name}: ${response.status}`);
    const data = await response.json();
    cache[key] = data;
    return data;
  }

  async function post(type, name, action, query = {}) {
    const params = new URLSearchParams(query);
    const url = path(type, name, action) + (params.size ? `?${params}` : "");
    // ESP-IDF's HTTP server rejects bodyless POST requests with HTTP 411.
    // A one-byte ignored body ensures browsers include Content-Length.
    const response = await fetch(url, { method: "POST", body: "_" });
    if (!response.ok) throw new Error(`${name}: ${response.status}`);
    toast("Command accepted");
    requestRefresh(500);
  }

  const press = (name) => post("button", name, "press");
  const setNumber = (name, value) => post("number", name, "set", { value });
  const setSwitch = (name, on) => post("switch", name, on ? "turn_on" : "turn_off");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  function value(key, fallback = "—") {
    const item = cache[key];
    if (!item) return fallback;
    if (item.value !== undefined && item.value !== null) return item.value;
    return item.state ?? fallback;
  }

  function state(key, fallback = "—") {
    return cache[key]?.state ?? fallback;
  }

  function fmtNumber(key, digits = 1, suffix = "") {
    const raw = Number(value(key, NaN));
    return Number.isFinite(raw) ? `${raw.toFixed(digits)}${suffix}` : "Unavailable";
  }

  function duration(secondsRaw) {
    const seconds = Number(secondsRaw);
    if (!Number.isFinite(seconds)) return "—";
    const daysPart = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return [daysPart ? `${daysPart}d` : "", hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${secs}s`]
      .filter(Boolean).join(" ");
  }

  function pillClass(text) {
    text = String(text).toLowerCase();
    if (text.includes("fault") || text.includes("invalid") || text.includes("not installed")) return "bad";
    if (text.includes("dosing") || text.includes("prime") || text.includes("unavailable")) return "warn";
    return "ok";
  }

  function render() {
    const appliance = String(state("status", "CONNECTING"));
    const applianceNode = document.querySelector("#appliance-state");
    applianceNode.textContent = appliance;
    applianceNode.className = `appliance-state ${appliance.toLowerCase()}`;
    document.querySelector("#current-time").textContent = state("currentTime");
    document.querySelector("#connection-text").textContent = online ? "Live device connection" : "Device unreachable";
    document.querySelector("#connection-dot").classList.toggle("off", !online);

    const values = {
      "m-rtc": state("rtcReadback"), "m-wifi": `${state("ssid")} · ${fmtNumber("wifi", 0, " dBm")}`,
      "m-api": state("api") === "ON" ? "Connected" : "Not connected", "m-pump": state("pump"),
      "m-last": state("last"), "m-next": state("next"), "m-today": fmtNumber("today", 2, " mL"),
      "m-volume": fmtNumber("totalVolume", 2, " mL"), "m-runtime": duration(value("totalRuntime")),
      "m-cal": state("calibration"), "m-reservoir": state("reservoir"), "m-flow": state("flowVerify"),
      "m-power": state("powerStatus"), "m-wake-reason": state("wakeReason"),
      "m-awake-remaining": state("awakeRemaining"), "m-next-wake": state("nextPowerWake"),
      "m-fault": state("faults"), "schedule-next": state("next"), "daily-limit-status": state("dailyLimit"),
      "lockout-status": state("lockout"), "net-info": `${state("ssid")} · ${state("ip")}`,
      "fw-info": state("fw"),
      "tz-info": state("timezone"), "schedule-time-source": state("timeStatus"),
      "rtc-readback-info": state("rtcReadback"),
      "rtc-sync-info": state("rtcSync"), "rtc-button-readback": state("rtcReadback"),
      "ps-status-info": state("powerStatus"), "ps-wake-info": state("wakeReason"),
      "ps-awake-info": state("awakeRemaining"), "ps-next-info": state("nextPowerWake"),
      "ps-action-info": state("powerAction"),
      "cal-info": state("calibration")
    };
    for (const [id, text] of Object.entries(values)) {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    }
    for (const id of ["m-rtc", "m-api", "m-pump", "m-fault"]) {
      const node = document.getElementById(id);
      if (node) node.className = `metric-value badge ${pillClass(node.textContent)}`;
    }
    renderApiKey();

    const calibrated = !String(state("calibration")).startsWith("UNCALIBRATED");
    document.querySelectorAll("[data-needs-cal]").forEach((node) => node.disabled = !calibrated);
    const enabled = state("scheduleEnabled") === "ON";
    document.querySelector("#schedule-toggle").classList.toggle("on", enabled);
    const powerEnabled = state("powerSaving") === "ON";
    document.querySelector("#power-saving-toggle")?.classList.toggle("on", powerEnabled);
    const sleepNow = document.querySelector('[data-press="Sleep Now"]');
    if (sleepNow) sleepNow.disabled = !powerEnabled;

    syncInputs();
    renderHistory();
  }

  function syncInputs() {
    const bindings = {
      "custom-seconds": "customTimed", "custom-ml": "customDose", "prime-seconds": "primeDuration",
      "schedule-ml": "scheduleDose", "max-runtime": "maxRuntime", "min-interval": "minInterval",
      "max-daily": "maxDaily", "cal-duration": "calibrationDuration", "cal-measured": "calibrationMeasured"
    };
    for (const [id, key] of Object.entries(bindings)) {
      const input = document.getElementById(id);
      if (input && document.activeElement !== input && cache[key]) input.value = value(key);
    }
    const timeInput = document.getElementById("schedule-time");
    if (timeInput && document.activeElement !== timeInput && cache.scheduleHour && cache.scheduleMinute) {
      timeInput.value = `${String(Math.round(value("scheduleHour"))).padStart(2, "0")}:${String(Math.round(value("scheduleMinute"))).padStart(2, "0")}`;
    }
    days.forEach((day) => {
      const node = document.querySelector(`[data-day="${day}"]`);
      if (node) node.classList.toggle("on", state(`day${day}`) === "ON");
    });
  }

  function renderHistory() {
    const host = document.getElementById("history-list");
    if (!host) return;
    let items = [];
    try { items = JSON.parse(state("history", "[]")); } catch (_) { /* transient partial state */ }
    if (!items.length) {
      host.innerHTML = '<div class="empty">No dose events recorded yet.</div>';
      return;
    }
    host.innerHTML = items.map((item) => `
      <div class="history-row">
        <div><strong>${escapeHtml(item.time)}</strong></div>
        <div>${escapeHtml(item.source)}<br><small>${Number(item.runtime_s).toFixed(1)} seconds</small></div>
        <div>${escapeHtml(item.result)}</div>
        <div>${Number(item.calculated_ml).toFixed(2)} mL<br><small>${Number(item.requested_ml).toFixed(2)} mL requested</small></div>
      </div>`).join("");
  }

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  function requestRefresh(delay = 0) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, delay);
  }

  async function fetchEntities(keys, concurrency = 3) {
    const queue = [...new Set(keys)];
    let firstError = null;
    const worker = async () => {
      while (queue.length) {
        const key = queue.shift();
        try { await getEntity(key); } catch (error) { firstError ||= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    if (firstError) throw firstError;
  }

  async function refresh() {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    const common = ["status", "currentTime", "pump", "faults", "calibration", "scheduleEnabled", "powerSaving"];
    const pageKeys = activePage === "status"
      ? ["rtc", "rtcReadback", "timeStatus", "last", "attempted", "next", "powerStatus", "wakeReason",
        "awakeRemaining", "nextPowerWake", "api", "today", "totalVolume", "totalRuntime", "wifi", "ssid",
        "reservoir", "flowVerify"]
      : activePage === "schedule"
        ? ["scheduleHour", "scheduleMinute", "scheduleDose", "next", "timeStatus", "dailyLimit", "lockout",
          ...days.map((day) => `day${day}`)]
        : activePage === "settings"
          ? ["maxRuntime", "minInterval", "maxDaily", "primeDuration", "calibrationDuration", "calibrationMeasured",
            "powerStatus", "wakeReason", "awakeRemaining", "nextPowerWake", "powerAction", "rtcReadback", "rtcSync",
            "ip", "ssid", "fw", "timezone", "api"]
          : activePage === "dose"
            ? ["customTimed", "customDose", "primeDuration", "dailyLimit", "lockout"]
            : activePage === "history" ? ["history"] : [];
    try {
      await fetchEntities([...common, ...pageKeys]);
      online = true;
    } catch (error) {
      online = false;
      console.warn(error);
    } finally {
      refreshInFlight = false;
    }
    render();
    if (refreshQueued) {
      refreshQueued = false;
      requestRefresh(250);
    }
  }

  function toast(message) {
    const node = document.getElementById("toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), 2200);
  }

  function renderApiKey() {
    const connected = state("api") === "ON" ? "Connected" : "Not connected";
    const toggle = document.getElementById("api-key-toggle");
    const valueNode = document.getElementById("api-key-value");
    const copy = document.getElementById("api-key-copy");
    if (!toggle || !valueNode || !copy) return;
    toggle.textContent = apiKeyVisible ? "Hide key" : `${connected} · Reveal key`;
    valueNode.hidden = !apiKeyVisible;
    copy.hidden = !apiKeyVisible;
    valueNode.textContent = apiKeyVisible ? apiKey : "";
  }

  async function toggleApiKey() {
    if (apiKeyVisible) {
      apiKeyVisible = false;
      apiKey = "";
      renderApiKey();
      return;
    }
    const response = await fetch("/api/home-assistant-key", { cache: "no-store" });
    if (!response.ok) throw new Error(`Home Assistant API key: ${response.status}`);
    const data = await response.json();
    if (!data.key) throw new Error("Home Assistant API key unavailable");
    apiKey = String(data.key);
    apiKeyVisible = true;
    renderApiKey();
  }

  async function copyApiKey() {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
    } catch (_) {
      const input = document.createElement("textarea");
      input.value = apiKey;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    toast("Home Assistant key copied");
  }

  async function saveSchedule() {
    const [hour, minute] = document.getElementById("schedule-time").value.split(":").map(Number);
    const dose = Number(document.getElementById("schedule-ml").value);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
        !Number.isInteger(minute) || minute < 0 || minute > 59 ||
        !Number.isFinite(dose) || dose <= 0 || dose > 10000)
      throw new Error("Enter a valid time and dose amount");
    await setNumber("Schedule Hour", hour);
    await setNumber("Schedule Minute", minute);
    await setNumber("Schedule Dose Volume", dose);
    await press("Commit Schedule");
    toast("Schedule saved on device");
  }

  function build() {
    document.title = "ZCS PRO · Zoogloea Control System";
    document.body.innerHTML = `
      <main class="shell">
        <header class="topbar"><div><div class="brand-kicker">Zoogloea Control System</div><h1>ZCS PRO</h1><div class="brand-byline">by Zoogloea Control System</div></div>
          <div class="live"><span id="connection-dot" class="live-dot"></span><span id="connection-text">Connecting…</span></div></header>
        <section class="hero"><div class="state-card"><div class="eyebrow">Appliance state</div><div id="appliance-state" class="appliance-state">CONNECTING</div><div id="current-time" class="substate">Loading local time…</div></div>
          <div class="stop-card"><button class="stop" data-press="STOP Pump">■ STOP PUMP</button></div></section>
        <nav class="tabs">${["status", "dose", "schedule", "settings", "history"].map((tab, i) => `<button class="tab ${i === 0 ? "active" : ""}" data-tab="${tab}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join("")}</nav>

        <section id="page-status" class="page active">
          <div class="metrics">
            ${metric("RTC", "m-rtc")}${metric("Wi-Fi", "m-wifi")}${metric("Home Assistant", "m-api")}${metric("Pump", "m-pump")}
            ${metric("Last dose", "m-last")}${metric("Next scheduled", "m-next")}${metric("Dispensed today", "m-today")}${metric("Lifetime volume", "m-volume")}
            ${metric("Pump runtime", "m-runtime")}${metric("Calibration", "m-cal")}${metric("Reservoir", "m-reservoir")}${metric("Flow verification", "m-flow")}
            ${metric("Power mode", "m-power")}${metric("Wake reason", "m-wake-reason")}${metric("Awake remaining", "m-awake-remaining")}${metric("Next power wake", "m-next-wake")}
          </div><div class="panel"><h2>Fault monitor</h2><p class="panel-note">Schedule execution is inhibited whenever time is invalid. Manual controls remain available.</p><div id="m-fault" class="badge">Loading…</div></div>
        </section>

        <section id="page-dose" class="page">
          <div class="panel"><h2>Volume dose</h2><p class="panel-note">Volume controls unlock only after a completed water calibration. Runs exceeding the configured or absolute 120-second limit are rejected.</p>
            <div class="control-grid">${[10,25,50,100].map((ml) => `<button class="btn primary" data-needs-cal data-press="Dose ${ml} mL">${ml} mL</button>`).join("")}</div>
            <div class="field" style="margin-top:14px"><label>Custom dose (mL)</label><div class="field-row"><input id="custom-ml" type="number" min="0" max="10000" step="0.1"><button class="btn primary" data-needs-cal id="run-custom-ml">Dose</button></div></div></div>
          <div class="panel"><h2>Timed manual run</h2><p class="panel-note">Manual timed runs are explicit actions and are allowed inside the automatic schedule lockout. Daily volume and continuous-runtime limits still apply when calibrated.</p>
            <div class="control-grid">${[5,15,30,60].map((sec) => `<button class="btn" data-press="Run ${sec} Seconds">${sec} seconds</button>`).join("")}</div>
            <div class="field" style="margin-top:14px"><label>Custom runtime (seconds)</label><div class="field-row"><input id="custom-seconds" type="number" min="1" max="120" step="1"><button class="btn" id="run-custom-time">Run</button></div></div></div>
          <div class="panel"><h2>Prime</h2><p class="panel-note">Prime is a timed run, never a latched ON control, and remains subject to the continuous-runtime watchdog.</p><div class="field-row"><input id="prime-seconds" type="number" min="1" max="120" step="1"><button class="btn warn" id="prime-pump">Prime Pump</button></div></div>
        </section>

        <section id="page-schedule" class="page">
          <div class="panel"><h2>Weekly schedule</h2><p class="panel-note">Stored and executed locally. Missed doses are logged and skipped—there is no catch-up dosing in v1.0.</p>
            <div class="toggle-row"><div><strong>Schedule enabled</strong><div class="panel-note" style="margin:3px 0 0">Requires valid time and calibration</div></div><button id="schedule-toggle" class="toggle" aria-label="Toggle schedule"></button></div>
            <div class="field" style="margin-top:16px"><label>Days</label><div class="days">${days.map((day) => `<button class="day" data-day="${day}">${day.slice(0,3)}</button>`).join("")}</div></div>
            <div class="grid-2" style="margin-top:16px"><div class="field"><label>Local time</label><input id="schedule-time" type="time"></div><div class="field"><label>Dose amount (mL)</label><input id="schedule-ml" type="number" min="0" max="10000" step="0.1"></div></div>
            <button class="btn primary" id="save-schedule" style="width:100%;margin-top:15px">Save Schedule</button></div>
          <div class="metrics" style="margin-top:14px">${metric("Next run preview", "schedule-next")}${metric("Automatic lockout", "lockout-status")}${metric("Daily limit", "daily-limit-status")}${metric("Time source", "schedule-time-source")}</div>
        </section>

        <section id="page-settings" class="page">
          <div class="panel"><h2>Calibration</h2><p class="panel-note">Use WATER. Run the pump for the known interval, measure the collected liquid, enter that amount, then save.</p>
            <div class="grid-2"><div class="field"><label>Calibration duration (seconds)</label><input id="cal-duration" type="number" min="10" max="120" step="1"></div><div class="field"><label>Measured volume (mL)</label><input id="cal-measured" type="number" min="0" max="10000" step="0.1"></div></div>
            <div class="control-grid" style="margin-top:14px"><button class="btn warn" id="run-cal">1 · Run Calibration</button><button class="btn primary" id="save-cal">2 · Save Measurement</button><button class="btn" data-press="Clear Calibration">Clear Calibration</button></div><p id="cal-info" class="panel-note" style="margin-top:14px"></p></div>
          <div class="panel"><h2>Safety settings</h2><div class="setting-list">
            ${setting("Maximum continuous runtime", "Hard-capped at 120 seconds", "max-runtime", 1, 120, 1)}
            ${setting("Automatic-dose minimum interval", "Scheduled doses only; manual actions remain explicit", "min-interval", 0, 1440, 1)}
            ${setting("Maximum daily dose", "0 means not configured; no default mL is invented", "max-daily", 0, 100000, 1)}
          </div><button class="btn primary" id="save-safety" style="width:100%;margin-top:14px">Save Safety Settings</button></div>
          <div class="panel"><h2>Power saving</h2><p class="panel-note">Commissioning mode uses a recoverable five-minute sleep. Leave disabled until the GPIO32 wake button is installed and tested.</p>
            <div class="toggle-row"><div><strong>Power Saving Enabled</strong><div class="panel-note" style="margin:3px 0 0">Disabled by default; the device remains continuously reachable</div></div><button id="power-saving-toggle" class="toggle" aria-label="Toggle power saving"></button></div>
            <div class="setting-list" style="margin-top:14px">
              ${infoSetting("Power state", "Current sleep controller state", "ps-status-info")}${infoSetting("Wake reason", "Cause of the current boot", "ps-wake-info")}${infoSetting("Awake remaining", "Countdown pauses while dosing", "ps-awake-info")}${infoSetting("Next wake", "Initial commissioning timer", "ps-next-info")}${infoSetting("Last action", "Power-controller response", "ps-action-info")}
            </div><div class="control-grid" style="margin-top:16px"><button class="btn" data-press="Stay Awake 30 Minutes">Stay Awake 30 Minutes</button><button class="btn primary" data-press="Sleep Now">Sleep Now</button></div>
          </div>
          <div class="panel"><h2>Device</h2><div class="setting-list">
            ${infoSetting("Time zone", "Compile-time ESPHome setting", "tz-info")}${infoSetting("RTC / time", "Read directly from the DS3231", "rtc-readback-info")}${infoSetting("RTC synchronization", "Writes verified network time to the DS3231", "rtc-sync-info")}${infoSetting("Wi-Fi", "Fallback AP does not erase credentials", "net-info")}${apiKeySetting()}${infoSetting("Firmware", "Secure OTA is enabled", "fw-info")}
            ${infoSetting("Web administrator password", "ESPHome web auth is compile-time; edit secrets.yaml and OTA to change", "password-info", "Provisioned securely")}
          </div><div class="control-grid" style="margin-top:16px"><button class="btn primary rtc-sync-button" data-press="Sync RTC from Network Time"><span>Sync RTC from Network</span><small id="rtc-button-readback">RTC: loading…</small></button><button class="btn" data-press="Reboot Device">Reboot</button><button class="btn" data-press="Clear Fault">Clear Fault</button><button class="btn danger" id="factory-reset">Factory Reset…</button></div>
            <p class="panel-note" style="margin-top:14px">OTA: use the ESPHome dashboard or <code>esphome run zcs-pro.yaml</code>. The pump is forced OFF at OTA start.</p></div>
        </section>

        <section id="page-history" class="page"><div class="panel"><h2>Dose history</h2><p class="panel-note">Newest first. Approximately 100 compact events are retained locally and flash writes are batched.</p><div id="history-list" class="history"><div class="empty">Loading history…</div></div></div></section>
        <div class="footer">ZCS PRO by Zoogloea Control System · Local control remains functional without Home Assistant</div>
      </main><div id="toast" class="toast">Command accepted</div>`;

    wire();
    refresh();
    setInterval(refresh, 10000);
  }

  const metric = (label, id) => `<div class="metric"><div class="metric-label">${label}</div><div id="${id}" class="metric-value">—</div></div>`;
  const setting = (title, note, id, min, max, step) => `<div class="setting"><div><strong>${title}</strong><small>${note}</small></div><input id="${id}" type="number" min="${min}" max="${max}" step="${step}"></div>`;
  const infoSetting = (title, note, id, fixed = "") => `<div class="setting"><div><strong>${title}</strong><small>${note}</small></div><span id="${id}" class="badge">${fixed || "—"}</span></div>`;
  const apiKeySetting = () => `<div class="setting credential-setting"><div><strong>Home Assistant API</strong><small>Click to reveal the ESPHome encryption key</small></div><div class="credential-actions"><button id="api-key-toggle" class="badge credential-button" type="button">Reveal key</button><button id="api-key-copy" class="btn compact" type="button" hidden>Copy</button></div><code id="api-key-value" class="secret-value" hidden></code></div>`;

  function wire() {
    document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
      activePage = button.dataset.tab;
      document.querySelectorAll(".tab").forEach((node) => node.classList.toggle("active", node === button));
      document.querySelectorAll(".page").forEach((node) => node.classList.toggle("active", node.id === `page-${activePage}`));
      refresh();
    }));
    document.querySelectorAll("[data-press]").forEach((button) => button.addEventListener("click", () => press(button.dataset.press).catch(fail)));
    document.getElementById("run-custom-ml").onclick = async () => { await setNumber("Custom Dose Volume", document.getElementById("custom-ml").value); await settle(); await press("Start Custom Volume Dose"); };
    document.getElementById("run-custom-time").onclick = async () => { await setNumber("Custom Timed Run", document.getElementById("custom-seconds").value); await settle(); await press("Start Custom Timed Run"); };
    document.getElementById("prime-pump").onclick = async () => { await setNumber("Prime Duration", document.getElementById("prime-seconds").value); await settle(); await press("Prime Pump"); };
    document.getElementById("schedule-toggle").onclick = () => setSwitch("Schedule Enabled", state("scheduleEnabled") !== "ON").catch(fail);
    document.getElementById("power-saving-toggle").onclick = () => setSwitch("Power Saving Enabled", state("powerSaving") !== "ON").catch(fail);
    document.querySelectorAll("[data-day]").forEach((button) => button.onclick = () => setSwitch(`Schedule ${button.dataset.day}`, !button.classList.contains("on")).catch(fail));
    document.getElementById("save-schedule").onclick = () => saveSchedule().catch(fail);
    document.getElementById("run-cal").onclick = async () => { await setNumber("Calibration Duration", document.getElementById("cal-duration").value); await settle(); await press("Run Calibration"); };
    document.getElementById("save-cal").onclick = async () => { await setNumber("Calibration Measured Volume", document.getElementById("cal-measured").value); await settle(); await press("Save Calibration"); };
    document.getElementById("save-safety").onclick = async () => {
      await setNumber("Maximum Continuous Runtime", document.getElementById("max-runtime").value);
      await setNumber("Automatic Dose Minimum Interval", document.getElementById("min-interval").value);
      await setNumber("Maximum Daily Dose", document.getElementById("max-daily").value);
      toast("Safety settings saved");
    };
    document.getElementById("api-key-toggle").onclick = () => toggleApiKey().catch(fail);
    document.getElementById("api-key-copy").onclick = () => copyApiKey().catch(fail);
    document.getElementById("factory-reset").onclick = async () => {
      if (!confirm("Factory reset erases Wi-Fi credentials, calibration, schedule, counters and history. Continue?")) return;
      if (!confirm("Final confirmation: reset ZCS PRO to factory defaults?")) return;
      await press("Arm Factory Reset");
      await settle();
      await press("Confirm Factory Reset");
    };
  }

  function fail(error) { console.error(error); toast("Command failed"); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
