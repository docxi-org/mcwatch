// Фикстуры конвейера для макета. Структура повторяет два маршрута брифа:
// оглавление (pipeline) и сырьё одного вызова (runDetail).

const SENT = [
  'Итак, перед нами игра, которую ждали примерно семь лет, и я честно не знаю, с чего начать.',
  'Первое, что бросается в глаза, — это работа с освещением в закрытых помещениях.',
  'Боевая система построена вокруг парирования, и первые два часа она кажется несправедливой.',
  'Здесь важно понимать, что разработчики не пытались сделать ремейк, они делали продолжение.',
  'Я прошёл кампанию за двенадцать часов и потратил ещё шесть на побочные задания.',
  'Отдельно скажу про оптимизацию: на средней сборке игра держит шестьдесят кадров почти везде.',
  'Просадки начинаются только в одной локации, и это, судя по форумам, известная проблема.',
  'Музыка здесь не выпячивается, но в нужный момент делает ровно то, что нужно сцене.',
  'Русская локализация текстовая, озвучка оригинальная, и в этом случае это правильное решение.',
  'Если вы играли в оригинал, вам будет что вспомнить, но игра не держится только на ностальгии.',
  'Микротранзакций нет, боевого пропуска нет, сезонов нет — полная игра сразу после установки.',
  'Финал я обсуждать не буду, но скажу, что он не обрывается и не оставляет вопросов.'
];

function transcript(chars, seed) {
  let out = [], i = seed % SENT.length, len = 0;
  while (len < chars) {
    const s = SENT[i % SENT.length];
    out.push(s);
    len += s.length + 1;
    i++;
  }
  return out.join(' ').slice(0, chars);
}

const REVIEWS = [
  ['IGN', 9, 'Capcom вернула серии её главное — вес удара и цену ошибки. Открытый мир между главами кажется лишним, но стоит вернуться в коридоры, и игра снова безупречна.'],
  ['GameSpot', 8, 'Блестящая боевая система, к которой прилагается сюжет, не всегда её достойный. Парирование здесь — отдельный вид удовольствия.'],
  ['Eurogamer', 9, 'Арт-дирекшен эпохи Сэнгоку сделан с редким вниманием: даже второстепенные улицы выглядят продуманными.'],
  ['PC Gamer', 8, 'На PC игра работает лучше, чем можно было ожидать от Capcom. Клавиатура и мышь поддерживаются полноценно.'],
  ['Polygon', 7, 'Вторая половина кампании начинает повторять боссов, и это единственное, что мешает назвать игру безоговорочной удачей.'],
  ['VG247', 9, 'Лучшая игра Capcom со времён последней Resident Evil. Демонические перчатки наконец ощущаются как оружие, а не как способность.'],
  ['Destructoid', 8, 'Игра требует терпения в первые часы и щедро платит за него в следующие десять.'],
  ['Shacknews', 8, 'Не всё в открытом мире работает, но каждый его элемент можно пропустить, и игра от этого не ломается.']
];

function reviewBlock(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = REVIEWS[i % REVIEWS.length];
    out.push('--- отзыв ' + (i + 1) + ' ---\nИздание: ' + r[0] + '\nОценка: ' + r[1] + '/10\nТекст: ' + r[2]);
  }
  return out.join('\n\n');
}

const SYS = {
  critic: 'Ты составляешь резюме по отзывам критиков на видеоигру. На вход получаешь набор отзывов, на выход выдаёшь JSON с тремя полями: likes — до пяти пунктов о том, что критики хвалят; dislikes — до пяти пунктов о том, что критикуют; summary — два-три предложения о том, в чём критики согласны, а в чём расходятся.\n\nПравила:\n— пиши по-русски, даже если отзывы на английском;\n— не выдумывай того, чего в отзывах нет;\n— не пересказывай отдельные отзывы, ищи общее;\n— если отзывов меньше трёх, верни null во всех полях;\n— в likes и dislikes пиши законченные утверждения, а не ярлыки.',
  user: 'Ты составляешь резюме по отзывам игроков на видеоигру. Формат ответа и правила те же, что для критиков, но учитывай, что игроки чаще пишут про цену, баги и время прохождения, а не про художественные решения. Отдельно отмечай, если оценки игроков расходятся с оценками критиков.',
  judge: 'Ты решаешь ровно один вопрос: играют ли в ролике именно в ту игру, которая указана в блоке ИГРА. На вход получаешь название игры и расшифровку речи автора. Верни JSON: matches — true или false; confidence — high, medium или low; reason — одно предложение по-русски о том, почему ты так решил.\n\nВажно:\n— обзор, превью, разбор и стрим одинаково подходят, важна только игра;\n— если автор говорит о другой части серии, это не совпадение;\n— если речь не о видеоиграх вообще, это не совпадение;\n— если расшифровка слишком короткая, чтобы понять, ставь low.',
  conclusion: 'Ты пишешь короткое заключение о видеоигре по расшифровке летсплея. Верни JSON: verdict — одно предложение о том, стоит ли игра внимания; strengths — до трёх пунктов; weaknesses — до трёх пунктов; spoilerFree — true, если в заключении нет сюжетных подробностей.\n\nПиши по-русски, опирайся только на расшифровку, не добавляй того, чего автор не говорил.',
  embedding: ''
};

const CANDIDATES = [
  { position: 1, videoId: 'L1zvS1gsAbc', title: 'Onimusha: Way of the Sword - Before You Buy', channel: 'gameranx', views: 1188210, durationS: 1087, transcriptChars: 20203, matches: false, confidence: 'low', reason: "Автор называет игру 'Onimusha Warlords' и разбирает переиздание 2019 года, а не новый релиз.", outcome: 'отбракован: другая игра' },
  { position: 2, videoId: 'stK-_oN5DXg', title: 'ONIMUSHA WAY OF THE SWORD — полное прохождение, часть 1', channel: 'Кисимо', views: 412870, durationS: 4361, transcriptChars: 54572, matches: true, confidence: 'high', reason: 'Автор с первых минут называет игру полностью и проходит вступительную главу.', outcome: 'взят' },
  { position: 3, videoId: 'Qv7bZm2xK9s', title: 'Top 10 Samurai Games You Should Play', channel: 'FalconVision', views: 298431, durationS: 812, transcriptChars: 9140, matches: false, confidence: 'high', reason: 'Подборка из десяти игр, целевая игра упоминается одной фразой.', outcome: 'отбракован: другая игра' },
  { position: 4, videoId: 'hJ4pR0wLm1c', title: 'Onimusha Way of the Sword - Full Game Walkthrough (No Commentary)', channel: 'SilentRuns', views: 176205, durationS: 9240, transcriptChars: null, matches: null, confidence: null, reason: '', outcome: 'нет расшифровки' },
  { position: 5, videoId: 'Zx8nQ3vTyBk', title: 'Onimusha WOTS — обзор без спойлеров', channel: 'ДваДжойстика', views: 88104, durationS: 1523, transcriptChars: 12760, matches: null, confidence: null, reason: '', outcome: 'не рассматривался' }
];

const onimushaRuns = {
  1: { stage: 'summary_critic', subject: null, system: SYS.critic, prompt: 'ИГРА\nНазвание: Onimusha: Way of the Sword\nПлатформы: PC, PlayStation 5, Xbox Series X\nДата выхода: 2026-09-04\n\nОТЗЫВЫ КРИТИКОВ (40 из 89, отобраны по длине текста)\n\n' + reviewBlock(40), output: { likes: ['Возвращение легендарной серии в прежней форме', 'Блестящая боевая система на парировании', 'Плотный арт-дирекшен эпохи Сэнгоку'], dislikes: ['Излишний открытый мир между главами', 'Повторяющиеся боссы во второй половине'], summary: 'Критики сходятся на том, что Capcom вернула серии её главное — вес удара и цену ошибки. Претензии почти все об одном: открытый мир разбавляет то, что работает лучше всего в тесных коридорах.' } },
  2: { stage: 'summary_user', subject: null, system: SYS.user, prompt: 'ИГРА\nНазвание: Onimusha: Way of the Sword\n\nОТЗЫВЫ ИГРОКОВ (28 из 28)\n\n' + reviewBlock(28), output: { likes: ['Ощущение удара и парирования', 'Нет микротранзакций', 'Хорошая оптимизация на PC'], dislikes: ['Короткая кампания за полную цену', 'Скучные побочные задания'], summary: 'Игроки оценивают выше критиков и спорят в основном о длительности: 12 часов кампании при полном ценнике устраивают не всех, но к самой боевой системе претензий почти нет.' } },
  3: { stage: 'embedding', subject: null, system: SYS.embedding, prompt: 'Onimusha: Way of the Sword. Action Adventure. Fight through bloodstained battlefields of the late Sengoku period as a swordsman bound to a demon gauntlet. Parry, counter and absorb the souls of those you cut down.', output: { dimensions: 1536, preview: [-0.0142, 0.0311, -0.0078, 0.0455, -0.0219, 0.0164, 0.0092, -0.0387], note: 'сохранено 1536 чисел, показаны первые восемь' } },
  4: { stage: 'letsplay_judge', subject: 'L1zvS1gsAbc', system: SYS.judge, prompt: 'ИГРА\nНазвание: Onimusha: Way of the Sword\n\nРАСШИФРОВКА РЕЧИ АВТОРА (20203 знаков)\n' + transcript(20203, 1), output: { matches: false, confidence: 'low', reason: "Автор называет игру 'Onimusha Warlords' и разбирает переиздание 2019 года, а не новый релиз." } },
  5: { stage: 'letsplay_judge', subject: 'stK-_oN5DXg', system: SYS.judge, prompt: 'ИГРА\nНазвание: Onimusha: Way of the Sword\n\nРАСШИФРОВКА РЕЧИ АВТОРА (54572 знаков)\n' + transcript(54572, 5), output: { matches: true, confidence: 'high', reason: 'Автор с первых минут называет игру полностью и проходит вступительную главу.' } },
  6: { stage: 'letsplay_conclusion', subject: 'stK-_oN5DXg', system: SYS.conclusion, prompt: 'ИГРА\nНазвание: Onimusha: Way of the Sword\n\nРАСШИФРОВКА ВЫБРАННОГО ЛЕТСПЛЕЯ (54572 знаков)\nКанал: Кисимо · просмотров 412870 · длительность 1:12:41\n' + transcript(54572, 5), output: { verdict: 'Игра стоит внимания, если вы готовы к первым двум часам, где она ничего не прощает.', strengths: ['Парирование, которое ощущается физически', 'Плотная работа со светом в закрытых локациях', 'Полная игра без внутриигровых покупок'], weaknesses: ['Открытый мир между главами разбавляет темп', 'Побочные задания однообразны'], spoilerFree: true } }
};

const PIPELINES = {
  'onimusha-way-of-the-sword': {
    recorded: true,
    totals: { calls: 6, failed: 0, promptTokens: 42944, completionTokens: 715, durationMs: 279767, costUsd: 0.0024276 },
    stages: [
      { key: 'crawl', title: 'Сбор карточки', kind: 'code', status: 'done', summary: '117 отзывов сохранено', runs: [], facts: [
        { key: 'Источник', value: 'metacritic.com/game/onimusha-way-of-the-sword' },
        { key: 'Отзывы критиков', value: '89' },
        { key: 'Отзывы игроков', value: '28' },
        { key: 'Платформы', value: 'PC, PlayStation 5, Xbox Series X' },
        { key: 'Обложка', value: 'сохранена' },
        { key: 'Трейлер', value: 'найден' }
      ] },
      { key: 'summary_critic', title: 'Резюме критиков', kind: 'llm', status: 'done', summary: 'резюме сохранено · причина пересчёта: missing · в модель ушло 40 отзывов из 89', facts: [], runs: [
        { id: 1, stage: 'summary_critic', subject: null, model: 'z-ai/glm-4.7-flash', status: 'ok', attempts: 1, durationMs: 8421, promptTokens: 12880, completionTokens: 214, costUsd: 0.00071, batchSize: 1, decision: 'резюме сохранено в базу', error: null, createdAt: '2026-09-07T10:44:02.118Z' }
      ] },
      { key: 'summary_user', title: 'Резюме игроков', kind: 'llm', status: 'done', summary: 'резюме сохранено · в модель ушло 28 отзывов из 28', facts: [], runs: [
        { id: 2, stage: 'summary_user', subject: null, model: 'z-ai/glm-4.7-flash', status: 'ok', attempts: 1, durationMs: 6104, promptTokens: 9012, completionTokens: 186, costUsd: 0.00051, batchSize: 1, decision: 'резюме сохранено в базу', error: null, createdAt: '2026-09-07T10:44:19.402Z' }
      ] },
      { key: 'embedding', title: 'Вектор описания', kind: 'llm', status: 'done', summary: 'вектор сохранён · 1536 чисел', facts: [], runs: [
        { id: 3, stage: 'embedding', subject: null, model: 'text-embedding-3-small', status: 'ok', attempts: 1, durationMs: 1240, promptTokens: 1094, completionTokens: 0, costUsd: 0.00002, batchSize: 16, decision: 'вектор сохранён, 1536 измерений', error: null, createdAt: '2026-09-07T10:44:41.870Z' }
      ] },
      { key: 'similar', title: 'Похожие игры', kind: 'code', status: 'done', summary: '5 из 131 прошли порог', runs: [], facts: [
        { key: 'Порог близости', value: '0.78' },
        { key: 'Сравнено с', value: '131 игрой' },
        { key: 'Resonance: A Plague Tale Legacy', value: '0.912' },
        { key: 'Last Light of Arden', value: '0.884' },
        { key: 'Vector Siege', value: '0.831' },
        { key: 'Apex of Thieves', value: '0.804' },
        { key: 'Skyward Tactics', value: '0.791' }
      ] },
      { key: 'letsplay_search', title: 'Поиск летсплеев', kind: 'code', status: 'done', summary: '5 кандидатов, по убыванию просмотров', runs: [], facts: [
        { key: 'Запрос', value: '"Onimusha Way of the Sword" gameplay' },
        { key: 'Найдено', value: '5 роликов' },
        { key: 'С расшифровкой', value: '4 из 5' },
        { key: 'Порядок', value: 'по убыванию просмотров' }
      ] },
      { key: 'letsplay_judge', title: 'Судья роликов', kind: 'llm', status: 'done', summary: 'взят', facts: [], runs: [
        { id: 4, stage: 'letsplay_judge', subject: 'L1zvS1gsAbc', model: 'z-ai/glm-4.7-flash', status: 'ok', attempts: 1, durationMs: 1869, promptTokens: 4935, completionTokens: 72, costUsd: 0.00027555, batchSize: 1, decision: 'отбракован: другая игра', error: null, createdAt: '2026-09-07T10:47:36.133Z' },
        { id: 5, stage: 'letsplay_judge', subject: 'stK-_oN5DXg', model: 'z-ai/glm-4.7-flash', status: 'ok', attempts: 1, durationMs: 2515, promptTokens: 13108, completionTokens: 84, costUsd: 0.00073, batchSize: 1, decision: 'взят как основной летсплей', error: null, createdAt: '2026-09-07T10:47:41.290Z' }
      ] },
      { key: 'letsplay_conclusion', title: 'Заключение по летсплею', kind: 'llm', status: 'done', summary: 'заключение сохранено · ролик stK-_oN5DXg', facts: [], runs: [
        { id: 6, stage: 'letsplay_conclusion', subject: 'stK-_oN5DXg', model: 'z-ai/glm-4.7-flash', status: 'ok', attempts: 3, durationMs: 256418, promptTokens: 13915, completionTokens: 159, costUsd: 0.00088, batchSize: 1, decision: 'заключение сохранено в базу', error: null, createdAt: '2026-09-07T10:52:11.640Z' }
      ] }
    ],
    candidates: CANDIDATES,
    runDetail: onimushaRuns
  },

  tidebound: {
    recorded: true,
    totals: { calls: 1, failed: 0, promptTokens: 962, completionTokens: 0, durationMs: 1180, costUsd: 0.00002 },
    stages: [
      { key: 'crawl', title: 'Сбор карточки', kind: 'code', status: 'done', summary: 'отзывов нет, карточка сохранена', runs: [], facts: [
        { key: 'Источник', value: 'metacritic.com/game/tidebound' },
        { key: 'Отзывы критиков', value: '0' },
        { key: 'Отзывы игроков', value: '0' },
        { key: 'Метаскор', value: '82 — выставлен без публикации отзывов' },
        { key: 'Обложка', value: 'сохранена' },
        { key: 'Трейлер', value: 'нет' }
      ] },
      { key: 'summary_critic', title: 'Резюме критиков', kind: 'llm', status: 'skipped', summary: 'отзывов критиков нет — резюмировать нечего', facts: [], runs: [] },
      { key: 'summary_user', title: 'Резюме игроков', kind: 'llm', status: 'skipped', summary: 'отзывов игроков нет — резюмировать нечего', facts: [], runs: [] },
      { key: 'embedding', title: 'Вектор описания', kind: 'llm', status: 'done', summary: 'вектор сохранён · 1536 чисел', facts: [], runs: [
        { id: 11, stage: 'embedding', subject: null, model: 'text-embedding-3-small', status: 'ok', attempts: 1, durationMs: 1180, promptTokens: 962, completionTokens: 0, costUsd: 0.00002, batchSize: 16, decision: 'вектор сохранён, 1536 измерений', error: null, createdAt: '2026-09-07T09:12:04.221Z' }
      ] },
      { key: 'similar', title: 'Похожие игры', kind: 'code', status: 'done', summary: '2 из 131 прошли порог', runs: [], facts: [
        { key: 'Порог близости', value: '0.78' },
        { key: 'Сравнено с', value: '131 игрой' },
        { key: 'Farmstead Echo', value: '0.842' },
        { key: 'Silent Orchard', value: '0.795' }
      ] },
      { key: 'letsplay_search', title: 'Поиск летсплеев', kind: 'code', status: 'done', summary: 'подходящих роликов не найдено', runs: [], facts: [
        { key: 'Запрос', value: '"Tidebound" gameplay' },
        { key: 'Найдено', value: '0 роликов' },
        { key: 'Причина', value: 'игра вышла два дня назад, летсплеев ещё нет' }
      ] },
      { key: 'letsplay_judge', title: 'Судья роликов', kind: 'llm', status: 'skipped', summary: 'кандидатов нет — судить нечего', facts: [], runs: [] },
      { key: 'letsplay_conclusion', title: 'Заключение по летсплею', kind: 'llm', status: 'skipped', summary: 'летсплей не выбран — заключение не составлялось', facts: [], runs: [] }
    ],
    candidates: [],
    runDetail: {
      11: { stage: 'embedding', subject: null, system: SYS.embedding, prompt: 'Tidebound. Simulation, Adventure. Run a lighthouse on a coast that changes shape with every tide. Log what washes up, decide what to keep.', output: { dimensions: 1536, preview: [0.0208, -0.0117, 0.0342, 0.0091, -0.0264, 0.0155, -0.0073, 0.0410], note: 'сохранено 1536 чисел, показаны первые восемь' } }
    }
  },

  'grand-prix-2027': {
    recorded: true,
    totals: { calls: 5, failed: 2, promptTokens: 51204, completionTokens: 402, durationMs: 418902, costUsd: 0.0031 },
    stages: [
      { key: 'crawl', title: 'Сбор карточки', kind: 'code', status: 'done', summary: '556 отзывов сохранено', runs: [], facts: [
        { key: 'Источник', value: 'metacritic.com/game/grand-prix-2027' },
        { key: 'Отзывы критиков', value: '44' },
        { key: 'Отзывы игроков', value: '512' },
        { key: 'Обложка', value: 'сохранена' },
        { key: 'Трейлер', value: 'нет' }
      ] },
      { key: 'summary_critic', title: 'Резюме критиков', kind: 'llm', status: 'done', summary: 'резюме сохранено · в модель ушло 40 отзывов из 44', facts: [], runs: [
        { id: 21, stage: 'summary_critic', subject: null, model: 'z-ai/glm-4.7-flash', status: 'ok', attempts: 2, durationMs: 74210, promptTokens: 12440, completionTokens: 168, costUsd: 0.00069, batchSize: 1, decision: 'резюме сохранено в базу', error: null, createdAt: '2026-09-07T08:14:02.118Z' }
      ] },
      { key: 'summary_user', title: 'Резюме игроков', kind: 'llm', status: 'failed', summary: 'вызов сорвался после трёх попыток — резюме не сохранено', facts: [], runs: [
        { id: 22, stage: 'summary_user', subject: null, model: 'z-ai/glm-4.7-flash', status: 'failed', attempts: 3, durationMs: 256104, promptTokens: 21980, completionTokens: 0, costUsd: 0.00121, batchSize: 1, decision: 'резюме не сохранено, этап отмечен как сорвавшийся', error: 'провайдер вернул 429 Too Many Requests на всех трёх попытках; окно ожидания 60 с исчерпано', createdAt: '2026-09-07T08:16:44.902Z' }
      ] },
      { key: 'embedding', title: 'Вектор описания', kind: 'llm', status: 'done', summary: 'вектор сохранён · 1536 чисел', facts: [], runs: [
        { id: 23, stage: 'embedding', subject: null, model: 'text-embedding-3-small', status: 'ok', attempts: 1, durationMs: 1310, promptTokens: 1084, completionTokens: 0, costUsd: 0.00002, batchSize: 12, decision: 'вектор сохранён, 1536 измерений', error: null, createdAt: '2026-09-07T08:21:10.004Z' }
      ] },
      { key: 'similar', title: 'Похожие игры', kind: 'code', status: 'done', summary: '1 из 131 прошла порог', runs: [], facts: [
        { key: 'Порог близости', value: '0.78' },
        { key: 'Сравнено с', value: '131 игрой' },
        { key: 'Mecha Drift 2', value: '0.801' }
      ] },
      { key: 'letsplay_search', title: 'Поиск летсплеев', kind: 'code', status: 'done', summary: '3 кандидата, по убыванию просмотров', runs: [], facts: [
        { key: 'Запрос', value: '"Grand Prix 2027" gameplay' },
        { key: 'Найдено', value: '3 ролика' },
        { key: 'С расшифровкой', value: '2 из 3' }
      ] },
      { key: 'letsplay_judge', title: 'Судья роликов', kind: 'llm', status: 'failed', summary: 'оба вызова сорвались — ролик не выбран', facts: [], runs: [
        { id: 24, stage: 'letsplay_judge', subject: 'Rp2mV9kLxQ0', model: 'z-ai/glm-4.7-flash', status: 'failed', attempts: 3, durationMs: 62140, promptTokens: 8640, completionTokens: 0, costUsd: 0.00048, batchSize: 1, decision: 'ролик пропущен, переход к следующему кандидату', error: 'модель вернула невалидный JSON на всех попытках: ожидалось поле matches', createdAt: '2026-09-07T08:23:02.400Z' },
        { id: 25, stage: 'letsplay_judge', subject: 'Kd7hN1sWpUe', model: 'z-ai/glm-4.7-flash', status: 'failed', attempts: 2, durationMs: 24138, promptTokens: 7060, completionTokens: 234, costUsd: 0.00041, batchSize: 1, decision: 'ролик пропущен, кандидаты исчерпаны', error: 'ответ модели не прошёл проверку схемы: confidence = "средняя" вместо high | medium | low', createdAt: '2026-09-07T08:24:19.118Z' }
      ] },
      { key: 'letsplay_conclusion', title: 'Заключение по летсплею', kind: 'llm', status: 'skipped', summary: 'летсплей не выбран — заключение не составлялось', facts: [], runs: [] }
    ],
    candidates: [
      { position: 1, videoId: 'Rp2mV9kLxQ0', title: 'Grand Prix 2027 Career Mode — First 90 Minutes', channel: 'TorqueTV', views: 640210, durationS: 5402, transcriptChars: 31840, matches: null, confidence: null, reason: '', outcome: 'вызов сорвался' },
      { position: 2, videoId: 'Kd7hN1sWpUe', title: 'GP 2027 — обзор на скорость', channel: 'Апекс', views: 210880, durationS: 1104, transcriptChars: 14210, matches: null, confidence: null, reason: '', outcome: 'вызов сорвался' },
      { position: 3, videoId: 'Yb0cT4fRnMi', title: 'Grand Prix 2027 — Silverstone Hotlap', channel: 'LapRecord', views: 84120, durationS: 268, transcriptChars: null, matches: null, confidence: null, reason: '', outcome: 'нет расшифровки' }
    ],
    runDetail: {
      21: { stage: 'summary_critic', subject: null, system: SYS.critic, prompt: 'ИГРА\nНазвание: Grand Prix 2027\n\nОТЗЫВЫ КРИТИКОВ (40 из 44)\n\n' + reviewBlock(40), output: { likes: ['Обновлённая физика шин', 'Полный официальный ростер сезона'], dislikes: ['Карьерный режим почти не изменился', 'Тот же движок и те же меню'], summary: 'Ежегодное обновление: физика стала точнее, всё остальное осталось прежним. Критики советуют брать только тем, кто пропустил прошлую часть.' } },
      22: { stage: 'summary_user', subject: null, system: SYS.user, prompt: 'ИГРА\nНазвание: Grand Prix 2027\n\nОТЗЫВЫ ИГРОКОВ (40 из 512, отобраны по длине текста)\n\n' + reviewBlock(40), output: null },
      23: { stage: 'embedding', subject: null, system: SYS.embedding, prompt: 'Grand Prix 2027. Racing, Sports. The official game of the 2027 season, with every team, circuit and driver of the championship.', output: { dimensions: 1536, preview: [0.0074, 0.0219, -0.0388, 0.0102, 0.0341, -0.0157, 0.0066, -0.0225], note: 'сохранено 1536 чисел, показаны первые восемь' } },
      24: { stage: 'letsplay_judge', subject: 'Rp2mV9kLxQ0', system: SYS.judge, prompt: 'ИГРА\nНазвание: Grand Prix 2027\n\nРАСШИФРОВКА РЕЧИ АВТОРА (31840 знаков)\n' + transcript(31840, 3), output: null },
      25: { stage: 'letsplay_judge', subject: 'Kd7hN1sWpUe', system: SYS.judge, prompt: 'ИГРА\nНазвание: Grand Prix 2027\n\nРАСШИФРОВКА РЕЧИ АВТОРА (14210 знаков)\n' + transcript(14210, 7), output: null }
    }
  },

  'rust-and-rain': { recorded: false, totals: null, stages: [], candidates: [], runDetail: {} }
};

const FALLBACK = {
  recorded: true,
  totals: { calls: 2, failed: 0, promptTokens: 2048, completionTokens: 0, durationMs: 2410, costUsd: 0.00004 },
  stages: [
    { key: 'crawl', title: 'Сбор карточки', kind: 'code', status: 'done', summary: 'карточка сохранена', runs: [], facts: [{ key: 'Источник', value: 'metacritic.com' }, { key: 'Отзывы', value: 'меньше трёх' }] },
    { key: 'summary_critic', title: 'Резюме критиков', kind: 'llm', status: 'skipped', summary: 'отзывов меньше трёх — резюмировать нечего', facts: [], runs: [] },
    { key: 'summary_user', title: 'Резюме игроков', kind: 'llm', status: 'skipped', summary: 'отзывов игроков нет — резюмировать нечего', facts: [], runs: [] },
    { key: 'embedding', title: 'Вектор описания', kind: 'llm', status: 'done', summary: 'вектор сохранён · 1536 чисел', facts: [], runs: [{ id: 91, stage: 'embedding', subject: null, model: 'text-embedding-3-small', status: 'ok', attempts: 1, durationMs: 1105, promptTokens: 1024, completionTokens: 0, costUsd: 0.00002, batchSize: 16, decision: 'вектор сохранён, 1536 измерений', error: null, createdAt: '2026-09-07T07:40:00.000Z' }] },
    { key: 'similar', title: 'Похожие игры', kind: 'code', status: 'done', summary: 'подходящих игр не нашлось', runs: [], facts: [{ key: 'Порог близости', value: '0.78' }, { key: 'Максимальная близость', value: '0.694 — ниже порога' }] },
    { key: 'letsplay_search', title: 'Поиск летсплеев', kind: 'code', status: 'done', summary: 'подходящих роликов не найдено', runs: [], facts: [{ key: 'Найдено', value: '0 роликов' }] },
    { key: 'letsplay_judge', title: 'Судья роликов', kind: 'llm', status: 'skipped', summary: 'кандидатов нет — судить нечего', facts: [], runs: [] },
    { key: 'letsplay_conclusion', title: 'Заключение по летсплею', kind: 'llm', status: 'skipped', summary: 'летсплей не выбран — заключение не составлялось', facts: [], runs: [] }
  ],
  candidates: [],
  runDetail: {
    91: { stage: 'embedding', subject: null, system: '', prompt: 'Описание игры для векторизации.', output: { dimensions: 1536, preview: [0.0112, -0.0208, 0.0347, 0.0064, -0.0175, 0.0231, -0.0089, 0.0402], note: 'сохранено 1536 чисел, показаны первые восемь' } }
  }
};

export function pipeline(slug) {
  return PIPELINES[slug] || FALLBACK;
}

export function runDetail(slug, id) {
  const p = pipeline(slug);
  return p.runDetail[id] || null;
}
