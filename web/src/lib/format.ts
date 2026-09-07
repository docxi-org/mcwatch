/**
 * Человеческие подписи. Всё чистое и без DOM — потому и проверяется тестами
 * из `test/` наравне с бэкендом.
 */

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** «2026-09-04» → «4 сентября 2026». Пусто — так и говорим. */
export function dateText(iso: string | null): string {
  if (!iso) return 'дата неизвестна';
  const parts = iso.split('-');
  const [year, month, day] = parts;
  const monthName = MONTHS[Number(month) - 1];
  if (parts.length !== 3 || !year || !day || !monthName) return iso;
  return `${Number(day)} ${monthName} ${year}`;
}

/** Русское склонение по числу: 1 отзыв, 2 отзыва, 5 отзывов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export function countText(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}

/** «12:03:20» по часам сервера: местное время браузера тут сбивало бы с толку. */
export function clockText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** «07.09.2026 13:00» UTC — для отметки последнего обхода. */
export function stampText(iso: string | null): string {
  if (!iso) return 'ещё не было';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'ещё не было';
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

/** «5 мин назад». `now` передаётся снаружи: часы сервера точнее браузерных. */
export function agoText(iso: string | null, now: number): string {
  if (!iso) return 'ещё не работал';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return 'ещё не работал';
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 5) return 'только что';
  if (sec < 60) return `${sec} с назад`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${countText(min, 'минуту', 'минуты', 'минут')} назад`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${countText(hours, 'час', 'часа', 'часов')} назад`;
  return `${countText(Math.round(hours / 24), 'день', 'дня', 'дней')} назад`;
}

/** Часы с последнего удачного обхода; `null` — обхода не было вовсе. */
export function hoursSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  return Math.max(0, (now - ts) / 3_600_000);
}

/** 1234567 → «1.2 млн»: точное число просмотров ролика ничего не решает. */
export function viewsText(views: number | null): string {
  if (views === null) return 'просмотры неизвестны';
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)} млн просмотров`;
  if (views >= 1_000) return `${Math.round(views / 1000)} тыс. просмотров`;
  return countText(views, 'просмотр', 'просмотра', 'просмотров');
}

/** 3725 → «1:02:05». */
export function durationText(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return 'длительность неизвестна';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const p = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
