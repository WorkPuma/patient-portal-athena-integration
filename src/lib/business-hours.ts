const CHICAGO_TIME_ZONE = "America/Chicago";

const _HOLIDAY_KEYS = [
  "new_years_day",
  "memorial_day",
  "independence_day",
  "thanksgiving_day",
  "christmas_day",
] as const;

type HolidayKey = (typeof _HOLIDAY_KEYS)[number];

export interface ChicagoBusinessWindow {
  isOpenNow: boolean;
  nextBusinessDate: Date;
  nextBusinessDateLabel: string;
}

interface ChicagoDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function utcNoonDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function ymdKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function getChicagoDateParts(now: Date): ChicagoDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = formatter.formatToParts(now);

  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  const weekdayShort = lookup("weekday");
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(lookup("year")),
    month: Number(lookup("month")),
    day: Number(lookup("day")),
    hour: Number(lookup("hour")),
    minute: Number(lookup("minute")),
    weekday: weekdayMap[weekdayShort] ?? 0,
  };
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  occurrence: number
): Date {
  const firstOfMonth = utcNoonDate(year, month, 1);
  const firstWeekday = firstOfMonth.getUTCDay();
  const dayOffset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + dayOffset + (occurrence - 1) * 7;
  return utcNoonDate(year, month, day);
}

function lastWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number
): Date {
  const firstOfNextMonth = utcNoonDate(year, month + 1, 1);
  const lastOfMonth = new Date(firstOfNextMonth.getTime() - 24 * 60 * 60 * 1000);
  const lastWeekday = lastOfMonth.getUTCDay();
  const dayOffset = (lastWeekday - weekday + 7) % 7;
  const day = lastOfMonth.getUTCDate() - dayOffset;
  return utcNoonDate(year, month, day);
}

function observeFixedDateHoliday(date: Date): Date {
  const weekday = date.getUTCDay();
  if (weekday === 6) {
    return new Date(date.getTime() - 24 * 60 * 60 * 1000);
  }
  if (weekday === 0) {
    return new Date(date.getTime() + 24 * 60 * 60 * 1000);
  }
  return date;
}

function getHolidayMapForYear(year: number): Map<HolidayKey, Date> {
  const newYears = observeFixedDateHoliday(utcNoonDate(year, 1, 1));
  const memorialDay = lastWeekdayOfMonth(year, 5, 1);
  const independence = observeFixedDateHoliday(utcNoonDate(year, 7, 4));
  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4);
  const christmas = observeFixedDateHoliday(utcNoonDate(year, 12, 25));

  return new Map<HolidayKey, Date>([
    ["new_years_day", newYears],
    ["memorial_day", memorialDay],
    ["independence_day", independence],
    ["thanksgiving_day", thanksgiving],
    ["christmas_day", christmas],
  ]);
}

function getHolidaySet(year: number): Set<string> {
  const set = new Set<string>();
  for (const y of [year - 1, year, year + 1]) {
    const map = getHolidayMapForYear(y);
    for (const holidayDate of map.values()) {
      set.add(
        ymdKey(
          holidayDate.getUTCFullYear(),
          holidayDate.getUTCMonth() + 1,
          holidayDate.getUTCDate()
        )
      );
    }
  }
  return set;
}

function isBusinessDay(year: number, month: number, day: number): boolean {
  const date = utcNoonDate(year, month, day);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;

  const holidays = getHolidaySet(year);
  return !holidays.has(ymdKey(year, month, day));
}

function nextCalendarDay(date: Date): Date {
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

export function formatChicagoDateLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO_TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function getChicagoBusinessWindow(now: Date = new Date()): ChicagoBusinessWindow {
  const chicago = getChicagoDateParts(now);
  const minutesNow = chicago.hour * 60 + chicago.minute;
  const isTodayBusinessDay = isBusinessDay(chicago.year, chicago.month, chicago.day);
  const isOpenNow =
    isTodayBusinessDay && minutesNow >= 8 * 60 && minutesNow < 17 * 60;

  // If a request comes after-hours, product copy expects follow-up "tomorrow
  // morning" semantics, so we always start from the next calendar day.
  let cursor = utcNoonDate(chicago.year, chicago.month, chicago.day);
  if (!isOpenNow) {
    cursor = nextCalendarDay(cursor);
  }

  while (
    !isBusinessDay(
      cursor.getUTCFullYear(),
      cursor.getUTCMonth() + 1,
      cursor.getUTCDate()
    )
  ) {
    cursor = nextCalendarDay(cursor);
  }

  return {
    isOpenNow,
    nextBusinessDate: cursor,
    nextBusinessDateLabel: formatChicagoDateLabel(cursor),
  };
}

