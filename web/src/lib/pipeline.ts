/**
 * Подписи и чтение сырья в окне конвейера. Числа — из спеки (`ui/Спека.dc.html`,
 * раздел «конвейер»): сырьё одного вызова доходит до 56 000 знаков, и читать
 * его надо тремя способами — прокруткой, свёрткой и поиском.
 */

/** Длиннее этого — показываем начало и кнопку «показать целиком». */
export const COLLAPSE_OVER = 2400;

/** Сколько знаков показывать в свёрнутом виде. */
export const COLLAPSE_TO = 1800;

/** Больше строк искать бессмысленно: список перестаёт читаться. */
export const MAX_HITS = 80;

/** «1.9 с», «4 мин 16 с». Миллисекунды человеку ничего не говорят. */
export function durationMsText(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} с`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min} мин ${sec} с`;
}

/**
 * Разряды разделяются неразрывным пробелом, как принято в русской
 * типографике: число не должно переноситься посреди разрядов.
 */
export function numberText(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('ru-RU');
}

/**
 * Стоимость всегда со знаком приближения: провайдер её не присылает, считаем
 * по прайсу из конфига. Подавать оценку фактом нельзя.
 */
export function costText(usd: number | null): string {
  if (usd === null) return '—';
  if (usd === 0) return '≈ $0';
  if (usd < 0.01) return `≈ $${usd.toFixed(5)}`;
  return `≈ $${usd.toFixed(2)}`;
}

export interface Collapsed {
  text: string;
  /** Нужна ли кнопка «показать целиком». */
  collapsible: boolean;
  hiddenChars: number;
}

/** Свёртка длинного сырья. Раскрытое возвращается как есть. */
export function collapse(text: string, expanded: boolean): Collapsed {
  if (text.length <= COLLAPSE_OVER || expanded) {
    return { text, collapsible: text.length > COLLAPSE_OVER, hiddenChars: 0 };
  }
  return {
    text: text.slice(0, COLLAPSE_TO),
    collapsible: true,
    hiddenChars: text.length - COLLAPSE_TO,
  };
}

export interface Hit {
  /** Номер строки в сырье, с единицы: по нему видно, где это в тексте. */
  num: number;
  text: string;
}

/**
 * Строки сырья, содержащие запрос. Регистр не важен: расшифровки приходят
 * как попало, и «Onimusha» с «onimusha» — одно и то же.
 */
export function searchHits(text: string, query: string): Hit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const hits: Hit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
    const line = lines[i] ?? '';
    if (line.toLowerCase().includes(needle)) hits.push({ num: i + 1, text: line });
  }
  return hits;
}
