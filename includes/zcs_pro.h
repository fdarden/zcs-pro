#pragma once

#include "esphome/components/time/real_time_clock.h"
#include "esphome/components/web_server_base/web_server_base.h"
#ifdef USE_ESP32
#include "driver/gpio.h"
#endif
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <string>

// The API encryption key is deliberately not an ESPHome entity: exposing it
// that way would publish the credential to Home Assistant. This handler is
// protected by the web server's existing digest-auth middleware and is only
// queried after an explicit click in the local Settings page.
class VBApiKeyHandler final : public AsyncWebHandler {
 public:
  explicit VBApiKeyHandler(std::string key) : key_(std::move(key)) {}

  bool canHandle(AsyncWebServerRequest *request) const override {
    if (request->method() != HTTP_GET) return false;
#ifdef USE_ESP32
    char url_buf[AsyncWebServerRequest::URL_BUF_SIZE];
    return request->url_to(url_buf) == "/api/home-assistant-key";
#else
    return request->url() == "/api/home-assistant-key";
#endif
  }

  void handleRequest(AsyncWebServerRequest *request) override {
    const std::string body = std::string{"{\"key\":\""} + key_ + "\"}";
    auto *response = request->beginResponse(200, "application/json", body);
    response->addHeader("Cache-Control", "no-store, max-age=0");
    response->addHeader("Pragma", "no-cache");
    response->addHeader("X-Content-Type-Options", "nosniff");
    request->send(response);
  }

  bool isRequestHandlerTrivial() const override { return false; }

 private:
  std::string key_;
};

inline void vb_register_api_key_handler(const char *key) {
  auto *base = esphome::web_server_base::global_web_server_base;
  if (base != nullptr) base->add_handler(new VBApiKeyHandler(key));
}

// Compact, trivially-copyable records are used so ESPHome's preferences layer
// can persist a 100-entry ring without writing once per pump-runtime second.
enum VBSource : uint8_t {
  VB_MANUAL = 0,
  VB_PRIME = 1,
  VB_HOME_ASSISTANT = 2,
  VB_SCHEDULE = 3,
  VB_CALIBRATION = 4,
  VB_MISSED_SCHEDULE = 5,
  VB_FAULT = 6,
};

enum VBResult : uint8_t {
  VB_SUCCESS = 0,
  VB_STOPPED = 1,
  VB_REJECTED_RUNTIME = 2,
  VB_REJECTED_UNCALIBRATED = 3,
  VB_REJECTED_DAILY_LIMIT = 4,
  VB_REJECTED_LOCKOUT = 5,
  VB_REJECTED_BUSY = 6,
  VB_MISSED = 7,
  VB_ABORTED_WATCHDOG = 8,
  VB_TIME_INVALID = 9,
  VB_CALIBRATION_SAVED = 10,
};

struct VBEvent {
  uint32_t epoch{0};
  uint32_t runtime_ms{0};
  float requested_ml{0.0f};
  float calculated_ml{0.0f};
  uint8_t source{VB_FAULT};
  uint8_t result{VB_SUCCESS};
  uint16_t reserved{0};
};

struct VBHistory {
  static constexpr uint32_t MAGIC = 0x56423130;  // "VB10"
  uint32_t magic{MAGIC};
  uint16_t head{0};
  uint16_t count{0};
  std::array<VBEvent, 100> events{};

  void ensure_valid() {
    if (magic != MAGIC || head >= events.size() || count > events.size()) {
      *this = VBHistory{};
    }
  }

  void add(uint32_t epoch, float requested_ml, float calculated_ml,
           uint32_t runtime_ms, uint8_t source, uint8_t result) {
    ensure_valid();
    events[head] = {epoch, runtime_ms, requested_ml, calculated_ml, source,
                    result, 0};
    head = static_cast<uint16_t>((head + 1U) % events.size());
    if (count < events.size()) count++;
  }

  static const char *source_name(uint8_t source) {
    switch (source) {
      case VB_MANUAL: return "Manual";
      case VB_PRIME: return "Prime";
      case VB_HOME_ASSISTANT: return "Home Assistant";
      case VB_SCHEDULE: return "Schedule";
      case VB_CALIBRATION: return "Calibration";
      case VB_MISSED_SCHEDULE: return "Missed Schedule";
      default: return "Fault/aborted";
    }
  }

  static const char *result_name(uint8_t result) {
    switch (result) {
      case VB_SUCCESS: return "Success";
      case VB_STOPPED: return "Stopped";
      case VB_REJECTED_RUNTIME: return "Rejected: runtime limit";
      case VB_REJECTED_UNCALIBRATED: return "Rejected: uncalibrated";
      case VB_REJECTED_DAILY_LIMIT: return "Rejected: daily limit";
      case VB_REJECTED_LOCKOUT: return "Rejected: automatic lockout";
      case VB_REJECTED_BUSY: return "Rejected: pump busy";
      case VB_MISSED: return "Missed (skipped)";
      case VB_ABORTED_WATCHDOG: return "Aborted: runtime watchdog";
      case VB_TIME_INVALID: return "Skipped: invalid time";
      case VB_CALIBRATION_SAVED: return "Calibration saved";
      default: return "Unknown";
    }
  }

  std::string to_json() {
    ensure_valid();
    std::string out{"["};
    out.reserve(256 + static_cast<size_t>(count) * 150U);
    char row[280];
    for (uint16_t i = 0; i < count; i++) {
      const size_t idx = (head + events.size() - 1U - i) % events.size();
      const auto &event = events[idx];
      char stamp[32] = "Time unavailable";
      if (event.epoch >= 1704067200UL) {
        const time_t raw = static_cast<time_t>(event.epoch);
        struct tm local_tm {};
        localtime_r(&raw, &local_tm);
        strftime(stamp, sizeof(stamp), "%Y-%m-%d %H:%M:%S", &local_tm);
      }
      std::snprintf(
          row, sizeof(row),
          "%s{\"time\":\"%s\",\"requested_ml\":%.2f,"
          "\"calculated_ml\":%.2f,\"runtime_s\":%.3f,"
          "\"source\":\"%s\",\"result\":\"%s\"}",
          i == 0 ? "" : ",", stamp, event.requested_ml,
          event.calculated_ml, event.runtime_ms / 1000.0f,
          source_name(event.source), result_name(event.result));
      out += row;
    }
    out += ']';
    return out;
  }
};

static_assert(sizeof(VBHistory) <= sizeof(uint32_t) * 502U,
              "VBHistory no longer fits its persistent storage blob");

inline VBHistory &vb_history(uint32_t (&storage)[502]) {
  return *reinterpret_cast<VBHistory *>(storage);
}

inline bool vb_sane_time(const esphome::ESPTime &now) {
  return now.is_valid() && now.year >= 2024 && now.year <= 2099 &&
         now.month >= 1 && now.month <= 12 && now.day_of_month >= 1 &&
         now.day_of_month <= 31 && now.hour <= 23 && now.minute <= 59;
}

inline uint32_t vb_local_day_key(const esphome::ESPTime &now) {
  if (!vb_sane_time(now)) return 0;
  return static_cast<uint32_t>(now.year * 10000 + now.month * 100 +
                               now.day_of_month);
}

inline std::string vb_format_epoch(uint32_t epoch) {
  if (epoch < 1704067200UL) return "Time unavailable";
  auto local_time = esphome::ESPTime::from_epoch_local(epoch);
  char text[40];
  local_time.strftime(text, sizeof(text), "%a %b %d, %Y %I:%M %p");
  return text;
}

inline void vb_previous_local_day(esphome::ESPTime &value) {
  value.day_of_week = value.day_of_week <= 1 ? 7 : value.day_of_week - 1;
  if (value.day_of_year <= 1) {
    value.year--;
    value.day_of_year = value.year % 4 == 0 ? 366 : 365;
  } else {
    value.day_of_year--;
  }
  if (value.day_of_month > 1) {
    value.day_of_month--;
    return;
  }
  value.month = value.month <= 1 ? 12 : value.month - 1;
  value.day_of_month = esphome::days_in_month(value.month, value.year);
}

inline uint32_t vb_schedule_epoch(esphome::ESPTime local_date, int hour,
                                  int minute) {
  local_date.hour = static_cast<uint8_t>(hour);
  local_date.minute = static_cast<uint8_t>(minute);
  local_date.second = 0;
  local_date.recalc_timestamp_local();
  return local_date.timestamp > 0
             ? static_cast<uint32_t>(local_date.timestamp)
             : 0;
}

inline uint32_t vb_next_schedule_epoch(const esphome::ESPTime &now,
                                       uint8_t days_mask, int hour,
                                       int minute) {
  if (!vb_sane_time(now) || days_mask == 0 || hour < 0 || hour > 23 ||
      minute < 0 || minute > 59)
    return 0;
  auto candidate = now;
  for (int offset = 0; offset <= 7; offset++) {
    if (offset > 0) candidate.increment_day();
    const uint8_t dow_bit =
        static_cast<uint8_t>(1U << (candidate.day_of_week - 1));
    const uint32_t epoch = vb_schedule_epoch(candidate, hour, minute);
    if (epoch > static_cast<uint32_t>(now.timestamp) &&
        (days_mask & dow_bit) != 0)
      return epoch;
  }
  return 0;
}

// Returns the most recent configured slot strictly between two timestamps.
// Used only to record missed schedules; callers never execute this slot.
inline uint32_t vb_missed_schedule_epoch(uint32_t previous, uint32_t now,
                                         uint8_t days_mask, int hour,
                                         int minute) {
  if (previous < 1704067200UL || now <= previous || days_mask == 0) return 0;
  auto candidate = esphome::ESPTime::from_epoch_local(now);
  uint32_t latest = 0;
  for (int offset = 0; offset <= 8; offset++) {
    if (offset > 0) vb_previous_local_day(candidate);
    const uint32_t epoch = vb_schedule_epoch(candidate, hour, minute);
    if (epoch <= previous || epoch >= now - 60U)
      continue;
    const uint8_t dow_bit =
        static_cast<uint8_t>(1U << (candidate.day_of_week - 1));
    if ((days_mask & dow_bit) != 0 && epoch > latest) latest = epoch;
  }
  return latest;
}
