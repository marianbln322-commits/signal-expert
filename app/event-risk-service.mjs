function parseTime(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseImportance(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 3 ? parsed : 0;
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class TradingEconomicsCalendarProvider {
  constructor(baseUrl, apiKey, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.name = "Trading Economics Economic Calendar";
    this.sourceId = "TRADING_ECONOMICS_CALENDAR";
  }

  async calendar(from, to, minImportance = 3) {
    if (!this.apiKey) throw new Error("Trading Economics API credential is not configured.");
    if (!Number.isInteger(minImportance) || minImportance < 1 || minImportance > 3) throw new Error("Economic calendar importance must be an integer from 1 to 3.");
    const path = `/calendar/country/united states/${from}/${to}`;
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("c", this.apiKey);
    url.searchParams.set("importance", String(minImportance));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "signal-expert/0.8.0" } });
      if (!response.ok) throw new Error(`${this.name} HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("Economic calendar response is not an array.");
      const events = payload.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Economic event ${index} is invalid.`);
        const startsAt = parseTime(raw.Date ?? raw.date);
        const title = cleanText(raw.Event ?? raw.event ?? raw.Category ?? raw.category);
        if (startsAt === null || !title) throw new Error(`Economic event ${index} is missing its date or title.`);
        return {
          id: String(raw.CalendarId ?? raw.calendarId ?? `${startsAt}:${title}`),
          title,
          category: cleanText(raw.Category ?? raw.category) ?? "Uncategorized",
          country: cleanText(raw.Country ?? raw.country) ?? "United States",
          currency: cleanText(raw.Currency ?? raw.currency) ?? "USD",
          importance: parseImportance(raw.Importance ?? raw.importance),
          startsAt: new Date(startsAt).toISOString(),
          actual: cleanText(raw.Actual ?? raw.actual),
          forecast: cleanText(raw.Forecast ?? raw.forecast),
          previous: cleanText(raw.Previous ?? raw.previous),
          expectedImpact: "BIDIRECTIONAL_VOLATILITY_RISK",
          directionalImpact: "NOT_INFERRED",
        };
      });
      const receivedAt = new Date().toISOString();
      return {
        events,
        source: this.sourceId,
        sourceName: this.name,
        sourceUrl: `${this.baseUrl}${path}`,
        sourceTimestamp: receivedAt,
        receivedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class EventRiskService {
  constructor({ provider = null, enabled = false, pollMs = 300000, staleAfterMs = 900000, preWindowMs = 1800000, postWindowMs = 900000, minImportance = 3 } = {}) {
    this.provider = provider;
    this.settings = { enabled, pollMs, staleAfterMs, preWindowMs, postWindowMs, minImportance };
    this.envelope = null;
    this.error = null;
    this.timer = null;
    this.busy = false;
  }

  async start() {
    if (!this.settings.enabled) return;
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.settings.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(now = new Date()) {
    if (this.busy || !this.settings.enabled) return;
    this.busy = true;
    try {
      if (!this.provider) throw new Error("Economic calendar provider is unavailable because no API credential is configured.");
      const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const to = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      this.envelope = await this.provider.calendar(from, to, this.settings.minImportance);
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Economic calendar request failed.";
    } finally {
      this.busy = false;
    }
  }

  status(now = new Date()) {
    const policy = {
      enabled: this.settings.enabled,
      failClosedWhenEnabled: true,
      preWindowMs: this.settings.preWindowMs,
      postWindowMs: this.settings.postWindowMs,
      minImportance: this.settings.minImportance,
    };
    if (!this.settings.enabled) return { status: "DISABLED", allowed: true, classification: "MACRO_FILTER_NOT_ENABLED", policy, events: [], activeEvents: [], reason: "Macro/news filtering is disabled by configuration." };
    if (!this.envelope) return { status: "UNAVAILABLE", allowed: false, classification: "ECONOMIC_CALENDAR_UNAVAILABLE", policy, events: [], activeEvents: [], error: this.error, reason: this.error ?? "No attributed economic calendar snapshot is available." };
    const received = parseTime(this.envelope.receivedAt);
    if (received === null || now.getTime() - received > this.settings.staleAfterMs) return { ...this.envelope, status: "STALE", allowed: false, classification: "ECONOMIC_CALENDAR_STALE", policy, activeEvents: [], error: this.error, reason: "Economic calendar snapshot is stale; entries fail closed." };
    const relevant = this.envelope.events.filter((event) => event.importance >= this.settings.minImportance && (event.currency === "USD" || event.country.toLowerCase().includes("united states")));
    const activeEvents = relevant.filter((event) => {
      const startsAt = parseTime(event.startsAt);
      return startsAt !== null && now.getTime() >= startsAt - this.settings.preWindowMs && now.getTime() <= startsAt + this.settings.postWindowMs;
    });
    return {
      ...this.envelope,
      status: activeEvents.length ? "BLACKOUT" : "CLEAR",
      allowed: activeEvents.length === 0,
      classification: "ATTRIBUTED_MACRO_EVENT_RISK_NOT_DIRECTIONAL_FORECAST",
      policy,
      events: relevant.sort((left, right) => left.startsAt.localeCompare(right.startsAt)).slice(0, 20),
      activeEvents,
      error: this.error,
      reason: activeEvents.length ? `${activeEvents.length} high-impact USD event(s) are inside the configured no-entry window.` : "No high-impact USD event is inside the configured no-entry window.",
    };
  }

  source() {
    return {
      id: this.provider?.sourceId ?? "ECONOMIC_CALENDAR_NOT_CONFIGURED",
      name: this.provider?.name ?? "Economic calendar",
      role: "MACRO_ENTRY_FILTER",
      type: this.settings.enabled ? "CONFIGURED_EXTERNAL_API" : "DISABLED",
      updateFrequency: this.settings.enabled ? `${this.settings.pollMs}ms` : null,
      limitations: "High-impact events are used as a bidirectional blackout gate. The software does not fabricate positive/negative crypto direction from an unreleased macro event.",
    };
  }
}
