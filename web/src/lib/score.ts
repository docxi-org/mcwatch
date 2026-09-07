/**
 * Две шкалы оценок. Главная предметная тонкость интерфейса: метаскор 0–100 и
 * оценка игроков 0–10 — числа разного происхождения, и путать их нельзя
 * (`docs/UI-BRIEF.md` §4).
 *
 * Пороги градации считаются от доли шкалы — 0.75 и 0.5, — поэтому формула
 * одна на оба типа, а 75 и 7.5 попадают в одну зону (`ui/Спека.dc.html`).
 */

export type ScoreKind = 'critic' | 'user';

/** `none` — оценки нет вовсе. Это не ноль: ноль сам по себе оценка. */
export type Tier = 'good' | 'mixed' | 'bad' | 'none';

export interface ScoreView {
  /** Есть ли оценка. `false` — рисуем пунктир и «нет оценки», не ноль. */
  present: boolean;
  /** Готовое к показу число: метаскор целым, оценка игроков с одним знаком. */
  value: string;
  /** Суффикс шкалы внутри плашки: `/100` или `/10`. */
  suffix: string;
  tier: Tier;
  /** Заполнение полосы под плашкой, 0–100. */
  fillPercent: number;
  /** Полная подпись шкалы для заголовков таблицы. */
  scaleLabel: string;
  /** Короткая подпись под плашкой в плитке списка. */
  shortLabel: string;
}

const SCALE_MAX: Record<ScoreKind, number> = { critic: 100, user: 10 };

export function tierOf(kind: ScoreKind, value: number | null): Tier {
  if (value === null) return 'none';
  const share = value / SCALE_MAX[kind];
  if (share >= 0.75) return 'good';
  if (share >= 0.5) return 'mixed';
  return 'bad';
}

export function scoreView(kind: ScoreKind, value: number | null): ScoreView {
  const critic = kind === 'critic';
  const scaleLabel = critic ? 'КРИТИКИ 0–100' : 'ИГРОКИ 0–10';
  const shortLabel = critic ? 'КРИТИКИ' : 'ИГРОКИ';

  if (value === null) {
    return {
      present: false,
      value: '—',
      suffix: '',
      tier: 'none',
      fillPercent: 0,
      scaleLabel,
      shortLabel,
    };
  }

  const max = SCALE_MAX[kind];
  return {
    present: true,
    // Метаскор целый по контракту; оценка игроков всегда с одним знаком,
    // иначе 8 и 8.0 читались бы как разные шкалы.
    value: critic ? String(Math.round(value)) : value.toFixed(1),
    suffix: critic ? '/100' : '/10',
    tier: tierOf(kind, value),
    fillPercent: Math.max(0, Math.min(100, Math.round((value / max) * 100))),
    scaleLabel,
    shortLabel,
  };
}
