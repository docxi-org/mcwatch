/**
 * Разбор JSON на подсвеченные кусочки. Нужен в двух местах: `data` события в
 * журнале мониторинга и ответ модели в окне конвейера. Разбор текстовый, а не
 * по разобранному объекту, — чтобы отступы и порядок ключей остались ровно
 * такими, какими их сделал `JSON.stringify`.
 */

export type TokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'plain';

export interface JsonToken {
  text: string;
  kind: TokenKind;
}

/**
 * Строка с кавычками, число, литерал или знак пунктуации. Двоеточие после
 * строки отличает ключ от значения — иначе `"да": "нет"` красились бы
 * одинаково.
 */
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

export function jsonTokens(text: string): JsonToken[] {
  const out: JsonToken[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), kind: 'plain' });

    const [, quoted, colon, num, literal, punct] = match;
    if (quoted !== undefined) {
      out.push({ text: quoted, kind: colon === undefined ? 'string' : 'key' });
      if (colon !== undefined) out.push({ text: colon, kind: 'punct' });
    } else if (num !== undefined) {
      out.push({ text: num, kind: 'number' });
    } else if (literal !== undefined) {
      out.push({ text: literal, kind: 'literal' });
    } else if (punct !== undefined) {
      out.push({ text: punct, kind: 'punct' });
    }

    last = TOKEN.lastIndex;
  }

  if (last < text.length) out.push({ text: text.slice(last), kind: 'plain' });
  return out;
}
