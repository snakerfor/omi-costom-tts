export type QuietHoursMode = 'drop_audio';

export interface QuietHoursConfig {
  enabled: boolean;
  timezone: string;
  start: string;
  end: string;
  mode: QuietHoursMode;
}

export interface QuietHoursStatus {
  active: boolean;
  config: QuietHoursConfig;
  localTime: string;
  minutesUntilStart: number | null;
}

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '22:00';
const DEFAULT_END = '08:00';

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseTimeToMinutes(value: string, fallback: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    console.warn(`[QuietHours] Invalid time "${value}"; using ${fallback}`);
    return parseTimeToMinutes(fallback, fallback);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeTime(value: string | undefined, fallback: string): string {
  if (!value || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(value.trim())) {
    if (value) {
      console.warn(`[QuietHours] Invalid time "${value}"; using ${fallback}`);
    }
    return fallback;
  }
  return value.trim();
}

function getLocalTimeParts(date: Date, timezone: string): { hour: number; minute: number; second: number; formatted: string } {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const hour = getPart('hour');
  const minute = getPart('minute');
  const second = getPart('second');
  return {
    hour,
    minute,
    second,
    formatted: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`,
  };
}

function isWithinQuietWindow(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) {
    return true;
  }
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function minutesUntilNextStart(nowMinutes: number, startMinutes: number): number {
  const delta = startMinutes - nowMinutes;
  return delta > 0 ? delta : delta + 24 * 60;
}

export function getQuietHoursConfig(): QuietHoursConfig {
  const mode = process.env.QUIET_HOURS_MODE?.trim() || 'drop_audio';
  if (mode !== 'drop_audio') {
    console.warn(`[QuietHours] Unsupported QUIET_HOURS_MODE=${mode}; using drop_audio`);
  }

  return {
    enabled: parseBoolEnv(process.env.QUIET_HOURS_ENABLED),
    timezone: process.env.QUIET_HOURS_TZ?.trim() || DEFAULT_TIMEZONE,
    start: normalizeTime(process.env.QUIET_HOURS_START, DEFAULT_START),
    end: normalizeTime(process.env.QUIET_HOURS_END, DEFAULT_END),
    mode: 'drop_audio',
  };
}

export function getQuietHoursStatus(now = new Date(), config = getQuietHoursConfig()): QuietHoursStatus {
  const local = getLocalTimeParts(now, config.timezone);
  const nowMinutes = local.hour * 60 + local.minute;
  const startMinutes = parseTimeToMinutes(config.start, DEFAULT_START);
  const endMinutes = parseTimeToMinutes(config.end, DEFAULT_END);
  const active = config.enabled && isWithinQuietWindow(nowMinutes, startMinutes, endMinutes);

  return {
    active,
    config,
    localTime: local.formatted,
    minutesUntilStart: config.enabled && !active ? minutesUntilNextStart(nowMinutes, startMinutes) : null,
  };
}
