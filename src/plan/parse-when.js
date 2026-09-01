// 사람이 적은 날짜·시간을 시각으로 바꿉니다.
//
// 소유자 결정: **"이번 주말" 같은 말은 해석하지 않습니다.** 날짜는 직접 적습니다.
// 그래서 여기는 "적어둔 날짜를 관대하게 읽어주는" 일만 합니다.
//
//   2026-10-03 18:30 / 2026.10.3 오후 6시 30분
//   10/3 18:30 / 10월 3일 오후 6시 / 10-3
//   내일 19시 / 오늘 저녁 7시
//
// ⚠️ 연도를 안 적으면 **가장 가까운 미래**로 봅니다.
//    12월에 "1/5" 를 적으면 내년 1월 5일입니다. 올해로 읽으면 이미 지난 날짜가 됩니다.

/** 시간을 안 적었을 때는 그날 종일로 봅니다. */
const DEFAULT_HOUR = 0;

const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {string} raw 사람이 적은 것
 * @param {Date} [now] 기준 시각 (검증용)
 * @returns {{ at: number, hasTime: boolean } | null} 못 읽으면 null
 */
export function parseWhen(raw, now = new Date()) {
  let text = String(raw ?? '').trim();
  if (!text) return null;

  // 오전/오후를 먼저 떼어둡니다. 숫자를 읽은 뒤에 12시간제를 적용합니다.
  let ampm = null;
  if (/오전|아침/.test(text)) ampm = 'am';
  if (/오후|저녁|밤/.test(text)) ampm = 'pm';
  text = text.replace(/오전|오후|아침|저녁|밤/g, ' ');

  // 오늘/내일/모레는 날짜를 적는 것과 다름없어서 받아줍니다.
  let dayShift = null;
  if (/모레/.test(text)) dayShift = 2;
  else if (/내일/.test(text)) dayShift = 1;
  else if (/오늘/.test(text)) dayShift = 0;
  text = text.replace(/모레|내일|오늘/g, ' ');

  // 구분자를 통일합니다. 2026-10-03 / 2026.10.3 / 10월 3일 / 10/3 을 같은 모양으로.
  const norm = text
    .replace(/[년월/.]/g, '-')
    .replace(/일/g, ' ')
    .replace(/시/g, ':')
    .replace(/분/g, ' ')
    .replace(/-+/g, '-')
    // ⚠️ "10월 3일" 은 위 치환을 거치면 "10- 3" 이 됩니다. 사이의 공백을 지우지 않으면
    //    날짜가 "10-" 에서 끊겨 못 읽습니다. (실제로 겪은 버그)
    .replace(/\s*-\s*/g, '-')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s+/g, ' ')
    .trim();

  const nums = norm.match(/\d+/g)?.map(Number) ?? [];
  if (nums.length === 0 && dayShift === null) return null;

  // 날짜 부분이 몇 개인지 봅니다. `-` 로 이어진 앞쪽이 날짜입니다.
  // 단 "내일 19시" 처럼 날짜를 말로 적었으면 숫자는 **전부 시간**입니다.
  const datePart = norm.split(/[\s:]/)[0] ?? '';
  const dateNums = dayShift !== null ? [] : datePart.match(/\d+/g)?.map(Number) ?? [];
  const timeNums = nums.slice(dateNums.length);

  let year;
  let month;
  let day;

  if (dayShift !== null && dateNums.length === 0) {
    // "내일 19시"
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayShift);
    year = base.getFullYear();
    month = base.getMonth() + 1;
    day = base.getDate();
  } else if (dateNums.length === 1 && datePart.length === 6) {
    // 251003 — 채널 이름에 쓰는 형식이라 그대로 적는 사람이 있습니다.
    const v = dateNums[0];
    year = 2000 + Math.floor(v / 10000);
    month = Math.floor((v % 10000) / 100);
    day = v % 100;
  } else if (dateNums.length >= 3) {
    // 2026-10-03
    [year, month, day] = dateNums;
    if (year < 100) year += 2000;
  } else if (dateNums.length === 2) {
    // 10-3 → 연도는 가장 가까운 미래
    [month, day] = dateNums;
    year = now.getFullYear();
  } else {
    return null; // 날짜를 못 읽었습니다
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let hour = DEFAULT_HOUR;
  let minute = 0;
  const hasTime = timeNums.length > 0;
  if (hasTime) {
    hour = timeNums[0];
    minute = timeNums[1] ?? 0;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
  }

  let at = new Date(year, month - 1, day, hour, minute, 0, 0);
  // 실제로 존재하는 날짜인지 확인합니다 (2월 31일 같은 것은 걸러야 합니다).
  if (at.getMonth() !== month - 1 || at.getDate() !== day) return null;

  // 연도를 안 적었으면 **가장 가까운 미래**로. 12월에 "1/5" 는 내년입니다.
  if (dateNums.length === 2 && at.getTime() < now.getTime()) {
    at = new Date(year + 1, month - 1, day, hour, minute, 0, 0);
  }

  return { at: at.getTime(), hasTime };
}

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/** 사람이 읽을 형태로. "10월 3일 (금) 오후 6:30" */
export function formatWhen(at, hasTime) {
  const d = new Date(at);
  const head = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY[d.getDay()]})`;
  if (!hasTime) return `${head} 종일`;
  const h = d.getHours();
  const ampm = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${head} ${ampm} ${h12}:${pad(d.getMinutes())}`;
}

/** 채널 이름에 쓸 `yymmdd`. */
export function yymmdd(at) {
  const d = new Date(at);
  return `${pad(d.getFullYear() % 100)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/**
 * 채널 이름에서 일정 제목을 뽑습니다. `[251003-오사카]` · `251003-오사카` → `오사카`
 * 이미 채널명에 적어둔 것을 또 타이핑하지 않게 하려는 것입니다.
 */
export function titleFromChannelName(name) {
  const cleaned = String(name ?? '').replace(/^[[\]\s]+|[[\]\s]+$/g, '');
  const m = cleaned.match(/^\d{6}[-_\s]+(.+)$/);
  return (m ? m[1] : cleaned).replace(/[-_]+/g, ' ').trim();
}
