import { ref, type Ref } from 'vue';
import { fetchStatus } from '../api/client.js';
import type { StatusDto } from '../api/types.js';

/**
 * Отметка о последнем обходе нужна и шапке, и полосе «обход давно не
 * удавался» на списке. Спрашиваем сервис один раз за загрузку страницы, а не
 * по разу на каждый экран.
 */

const status = ref<StatusDto | null>(null);
let pending: Promise<void> | null = null;

export function useServiceStatus(): {
  status: Ref<StatusDto | null>;
  load: () => Promise<void>;
} {
  const load = (): Promise<void> => {
    pending ??= fetchStatus()
      .then((next) => {
        status.value = next;
      })
      .catch(() => {
        // Каталог обязан открываться и без мониторинга: отметка о последнем
        // обходе — украшение, а не условие показа списка.
        status.value = null;
      });
    return pending;
  };

  return { status, load };
}

/** Когда crawler в последний раз что-то делал; `null` — не работал ни разу. */
export function crawlerLastRun(snapshot: StatusDto | null): string | null {
  return snapshot?.workers.find((w) => w.worker === 'crawler')?.lastRunAt ?? null;
}
