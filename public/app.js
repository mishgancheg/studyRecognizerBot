// Mini App: выбор семестра и предмета, загрузка фото, ожидание распознавания, правка и сохранение текста.
// Черновик (поля формы, номер задания, текст по страницам) хранится в localStorage, поэтому свёрнутое или
// закрытое приложение при повторном открытии продолжает с того же места. Фото после распознавания берутся
// с сервера, из каталога задания.
(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    // Свайп вниз по тексту или фото должен прокручивать их, а не сворачивать приложение.
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
  }
  if (window.marked) window.marked.setOptions({ breaks: true });
  // Внутри Telegram кнопка «Сохранить» — его собственная нижняя кнопка, она не занимает место на экране.
  const useMainButton = !!(tg && tg.initData && tg.MainButton);

  const $ = (id) => document.getElementById(id);
  const DRAFT_KEY = 'textrec-draft-v2'; // v2: текст хранится по страницам (draft.pages)
  const NEW_SUBJECT = '__new__';
  const MAX_SIDE = 2400; // фото ужимаются на телефоне: так загрузка быстрее, а текст остаётся читаемым
  const SEMESTERS_MIN = 8;

  /** @type {{ file: File, url: string }[]} */
  let photos = [];
  let tree = [];
  let pollTimer = null;

  // ── Черновик ──────────────────────────────────────────────
  const draft = loadDraft();
  function loadDraft() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }
  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* хранилище недоступно — работаем без черновика */
    }
  }
  function clearDraft() {
    for (const k of Object.keys(draft)) delete draft[k];
    saveDraft();
  }

  // ── Запросы к серверу ─────────────────────────────────────
  const authHeader = () => ({ Authorization: `tma ${(tg && tg.initData) || ''}` });

  async function api(path, options = {}) {
    const res = await fetch(path, { ...options, headers: { ...authHeader(), ...(options.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Сервер ответил кодом ${res.status}`);
    return body;
  }

  /** Загрузка через XMLHttpRequest — ради полосы прогресса. */
  function uploadPhotos(blobs, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      blobs.forEach((b, i) => form.append('photos', b, `${String(i + 1).padStart(2, '0')}.jpg`));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/recognize');
      xhr.setRequestHeader('Authorization', authHeader().Authorization);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* пустой ответ */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Сервер ответил кодом ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Нет связи с сервером'));
      xhr.send(form);
    });
  }

  // ── Шаги ──────────────────────────────────────────────────
  function show(step) {
    for (const s of document.querySelectorAll('.step')) s.hidden = s.id !== `step-${step}`;
    draft.step = step;
    saveDraft();
    window.scrollTo(0, 0);
    if (tg) step === 'edit' ? tg.enableClosingConfirmation() : tg.disableClosingConfirmation();
    if (useMainButton) step === 'edit' ? tg.MainButton.show() : tg.MainButton.hide();
  }
  function setError(id, message) {
    const el = $(id);
    el.textContent = message || '';
    el.hidden = !message;
  }

  // ── Шаг 1: форма ──────────────────────────────────────────
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function fillSemesters() {
    const max = Math.max(SEMESTERS_MIN, ...tree.map((s) => s.number));
    const sel = $('semester');
    sel.innerHTML = '';
    for (let n = 1; n <= max; n++) sel.add(new Option(`${n} семестр`, String(n)));
    const latest = tree.length ? tree[tree.length - 1].number : 1;
    sel.value = String(draft.semester || latest);
    fillSubjects();
  }

  function fillSubjects() {
    const n = Number($('semester').value);
    const subjects = (tree.find((s) => s.number === n) || { subjects: [] }).subjects;
    const sel = $('subject');
    sel.innerHTML = '';
    for (const s of subjects) sel.add(new Option(s, s));
    sel.add(new Option('➕ Новый предмет…', NEW_SUBJECT));
    sel.value = draft.subject && subjects.includes(draft.subject) ? draft.subject : subjects[0] || NEW_SUBJECT;
    if (draft.subject && !subjects.includes(draft.subject)) {
      sel.value = NEW_SUBJECT;
      $('new-subject').value = draft.subject;
    }
    $('new-subject-field').hidden = sel.value !== NEW_SUBJECT;
    updateRecognizeButton();
  }

  function chosenSubject() {
    return $('subject').value === NEW_SUBJECT ? $('new-subject').value.trim() : $('subject').value;
  }

  function rememberForm() {
    draft.semester = $('semester').value;
    draft.subject = chosenSubject();
    draft.date = $('date').value;
    draft.topic = $('topic').value.trim();
    saveDraft();
    updateRecognizeButton();
  }

  function updateRecognizeButton() {
    $('recognize-btn').disabled = !photos.length || !chosenSubject() || !$('date').value;
  }

  function renderPhotos() {
    const box = $('photos');
    box.innerHTML = '';
    photos.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'photo';
      el.innerHTML = `<img alt=""><span class="num">${i + 1}</span>
        <div class="ctrl"><button data-act="left" aria-label="Раньше">◀</button>
        <button data-act="del" aria-label="Убрать">✕</button>
        <button data-act="right" aria-label="Позже">▶</button></div>`;
      el.querySelector('img').src = p.url;
      el.querySelector('.ctrl').addEventListener('click', (e) => {
        const act = e.target.dataset.act;
        if (act === 'del') {
          URL.revokeObjectURL(p.url);
          photos.splice(i, 1);
        } else if (act === 'left' && i > 0) {
          [photos[i - 1], photos[i]] = [photos[i], photos[i - 1]];
        } else if (act === 'right' && i < photos.length - 1) {
          [photos[i + 1], photos[i]] = [photos[i], photos[i + 1]];
        }
        renderPhotos();
      });
      box.appendChild(el);
    });
    updateRecognizeButton();
  }

  /** Ужимает фото до MAX_SIDE по длинной стороне с учётом поворота из EXIF. Не вышло — отдаёт оригинал. */
  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * k);
      canvas.height = Math.round(bmp.height * k);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close && bmp.close();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      return blob || file;
    } catch {
      return file;
    }
  }

  async function startRecognition() {
    setError('form-error', '');
    rememberForm();
    show('wait');
    $('wait-back-btn').hidden = true;
    setError('wait-error', '');
    $('wait-title').textContent = 'Готовлю фото…';
    try {
      const blobs = [];
      for (const p of photos) blobs.push(await shrink(p.file));
      const { id } = await uploadPhotos(blobs, (k) => {
        $('wait-title').textContent = `Загружаю фото… ${Math.round(k * 100)}%`;
      });
      draft.jobId = id;
      saveDraft();
      pollJob();
    } catch (e) {
      waitFailed(e.message);
    }
  }

  // ── Шаг 2: ожидание ───────────────────────────────────────
  function waitFailed(message) {
    clearTimeout(pollTimer);
    delete draft.jobId;
    saveDraft();
    $('wait-title').textContent = 'Не получилось';
    setError('wait-error', message);
    $('wait-back-btn').hidden = false;
  }

  async function pollJob() {
    clearTimeout(pollTimer);
    show('wait');
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(draft.jobId)}`);
      if (job.status === 'done') {
        draft.pages = job.pages;
        draft.photosJob = draft.jobId;
        draft.page = 0;
        delete draft.jobId;
        saveDraft();
        openEditor();
        if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        return;
      }
      if (job.status === 'error') return waitFailed(job.error);
      const since = Math.round((Date.now() - (job.started || job.created)) / 1000);
      $('wait-title').textContent =
        job.status === 'queued' ? 'В очереди на распознавание…' : `Распознаю ${job.photos} фото… ${since} с`;
    } catch (e) {
      $('wait-title').textContent = `Нет ответа от сервера, повторяю… (${e.message})`;
    }
    pollTimer = setTimeout(pollJob, 2500);
  }

  // ── Шаг 3: правка ─────────────────────────────────────────
  // Каждое фото — отдельная страница со своим текстом. Сверху фото текущей страницы, снизу её текст:
  // сначала в виде просмотра, нажатие на текст открывает редактор ровно в месте нажатия.
  const ICON_EDIT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const ICON_READ =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2Z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7Z"/></svg>';
  const editor = $('editor');
  const preview = $('preview');
  let mode = 'read';
  let pageIndex = 0;
  let renderedMath = []; // формулы текущего просмотра и их место в исходном тексте
  let caretAnchor = 0; // на какой высоте от верха текста держать строку с курсором
  const photoUrls = new Map(); // имя фото → Promise с адресом картинки в памяти браузера

  const pages = () => draft.pages || [];
  const currentPage = () => pages()[pageIndex];

  function openEditor() {
    const topic = draft.topic ? ` · ${draft.topic}` : '';
    $('target').textContent = `${draft.semester} семестр / ${draft.subject} / Записи · ${draft.date}${topic}`;
    $('save-fallback-btn').hidden = useMainButton;
    renderPageList();
    show('edit');
    selectPage(Math.min(draft.page || 0, pages().length - 1));
  }

  function selectPage(i) {
    if (mode === 'edit') syncEditor();
    pageIndex = Math.max(0, i);
    draft.page = pageIndex;
    saveDraft();
    editor.value = currentPage().text;
    $('drawer-tab-num').textContent = String(pageIndex + 1);
    markActivePage();
    setRead();
    preview.scrollTop = 0;
    showPhoto(currentPage().photo);
  }

  function syncEditor() {
    currentPage().text = editor.value;
    saveDraft();
  }

  function setRead() {
    mode = 'read';
    renderPreview();
    editor.hidden = true;
    preview.hidden = false;
    $('mode-btn').innerHTML = ICON_EDIT;
    $('mode-btn').setAttribute('aria-label', 'Редактировать');
  }

  function renderPreview() {
    const src = currentPage().text;
    preview.innerHTML = src.trim()
      ? renderMarkdown(src)
      : '<p class="empty">На этой странице текста нет. Нажмите, чтобы написать.</p>';
  }

  /** Просмотр → редактор. x, y — точка нажатия; строка под ней остаётся на той же высоте экрана. */
  function enterEdit(x, y) {
    const { pos, lineTop } = sourceAtPoint(x, y);
    const paneTop = editor.parentElement.getBoundingClientRect().top;
    mode = 'edit';
    preview.hidden = true;
    editor.hidden = false;
    $('mode-btn').innerHTML = ICON_READ;
    $('mode-btn').setAttribute('aria-label', 'Чтение');
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(pos, pos);
    caretAnchor = lineTop - paneTop;
    editor.scrollTop = Math.max(0, caretTop(editor, pos) - caretAnchor);
  }

  /** Редактор → просмотр: место под курсором остаётся на той же высоте экрана. */
  function enterRead() {
    const pos = editor.selectionStart;
    const anchor = caretTop(editor, pos) - editor.scrollTop;
    syncEditor();
    editor.blur();
    setRead();
    const top = previewTopForSource(pos);
    if (top !== null) preview.scrollTop += top - preview.getBoundingClientRect().top - anchor;
  }

  /** Когда открывается или прячется клавиатура, строка с курсором не должна уезжать из виду. */
  function keepCaretVisible() {
    if (mode !== 'edit' || editor.hidden) return;
    const lh = parseFloat(getComputedStyle(editor).lineHeight) || 24;
    const top = caretTop(editor, editor.selectionStart);
    const y = top - editor.scrollTop;
    if (y < 0 || y + lh * 1.5 > editor.clientHeight) {
      editor.scrollTop = Math.max(0, top - Math.min(caretAnchor, editor.clientHeight - lh * 2));
    }
  }

  // ── Сопоставление просмотра и исходного текста ───────────
  // Просмотр собран из блоков (абзац, список, таблица…), у каждого записано, какой участок исходного
  // текста он показывает (data-s, data-e). Внутри блока видимые буквы по очереди находятся в исходнике:
  // значки разметки (#, **, скобки ссылок) пропускаются, потому что в просмотре их нет. Формула —
  // отдельный кусок с такими же отметками; внутри неё видимые символы так же ищутся в коде LaTeX, поэтому
  // нажатие на «x» в дроби ставит курсор к этому «x», а не просто в начало формулы.

  /** Обходит видимые символы по порядку; формулу внутри блока отдаёт целиком. */
  function* visibleChars(root) {
    for (let n = root.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        for (let i = 0; i < n.data.length; i++) yield { node: n, i, ch: n.data[i] };
      } else if (n.nodeType === 1 && !n.classList.contains('katex-mathml')) {
        if (n.classList.contains('m')) yield { math: n };
        else yield* visibleChars(n);
      }
    }
  }

  /** Ищет видимый символ в исходнике недалеко от from и не дальше limit. Пробелы не сопоставляются. */
  function findInSource(ch, from, limit) {
    if (/\s/.test(ch)) return -1;
    const idx = currentPage().text.indexOf(ch, from);
    return idx >= 0 && idx < limit && idx - from <= 80 ? idx : -1;
  }
  /**
   * Поиск видимого символа формулы в её коде LaTeX. Порядок символов на экране и в коде бывает разным
   * (у дроби KaTeX рисует знаменатель раньше числителя), поэтому, не найдя символ впереди, ищем и
   * позади. Буквы внутри команд (\frac, \sin) берутся в последнюю очередь, и тогда курсор ставится
   * перед всей командой.
   */
  function findInTex(ch, from, start, end) {
    if (/\s/.test(ch)) return -1;
    const t = currentPage().text;
    const commandStart = (i) => {
      let j = i;
      while (j > start && /[A-Za-z]/.test(t[j - 1])) j--;
      return /[A-Za-z]/.test(t[i]) && t[j - 1] === '\\' ? j - 1 : -1;
    };
    const scan = (a, b, allowCommand) => {
      for (let i = t.indexOf(ch, a); i >= 0 && i < b; i = t.indexOf(ch, i + 1)) {
        const c = commandStart(i);
        if (c < 0) return i;
        if (allowCommand) return c;
      }
      return -1;
    };
    for (const [a, b, cmd] of [[from, end, false], [start, from, false], [from, end, true], [start, from, true]]) {
      const idx = scan(a, b, cmd);
      if (idx >= 0) return idx;
    }
    return -1;
  }
  const nextMathStart =(pos) => (renderedMath.find((m) => m.s >= pos) || { s: Infinity }).s;
  const mathBounds = (el) => {
    const d = Number(el.dataset.d);
    return { start: Number(el.dataset.s) + d, end: Number(el.dataset.e) - d };
  };
  const isDisplayMath = (el) => !!el.querySelector('.katex-display');

  function caretAtPoint(x, y) {
    if (document.caretPositionFromPoint) {
      const c = document.caretPositionFromPoint(x, y);
      return c && { node: c.offsetNode, offset: c.offset };
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r && { node: r.startContainer, offset: r.startOffset };
    }
    return null;
  }

  function charRect(node, i) {
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, Math.min(i + 1, node.data.length));
    return r.getClientRects()[0] || r.getBoundingClientRect();
  }

  /** Точка в просмотре → позиция в исходном тексте и верх строки на экране. */
  function sourceAtPoint(x, y) {
    const lh = 24;
    const text = currentPage().text;
    const caret = caretAtPoint(x, y);
    const el = caret && (caret.node.nodeType === 1 ? caret.node : caret.node.parentElement);
    const blk = el && preview.contains(el) && el.closest('.blk');
    if (!blk) {
      // Нажатие мимо текста (поля, промежуток между абзацами): берём ближайший блок ниже.
      const blocks = [...preview.querySelectorAll('.blk')];
      const below = blocks.find((b) => b.getBoundingClientRect().bottom > y);
      if (below) return { pos: Number(below.dataset.s), lineTop: below.getBoundingClientRect().top };
      return { pos: text.length, lineTop: y - lh / 2 };
    }
    const stop = document.createRange();
    stop.setStart(caret.node, caret.offset);
    const reached = (node, i) => stop.comparePoint(node, i) >= 0;
    let lineTop = y - lh / 2;
    if (caret.node.nodeType === 3 && caret.node.data.length) {
      lineTop = charRect(caret.node, Math.min(caret.offset, caret.node.data.length - 1)).top;
    }

    const math = el.closest('.m');
    if (math) {
      // Для мелких символов формулы (индексы, знаменатели) браузер часто называет не букву, а обёртку
      // вокруг неё, поэтому нажатый символ ищем сами — ближайший к пальцу по положению на экране.
      const { start, end } = mathBounds(math);
      let target = null;
      let best = Infinity;
      for (const ev of visibleChars(math)) {
        if (ev.math || /\s/.test(ev.ch)) continue;
        const r = charRect(ev.node, ev.i);
        const dx = Math.max(r.left - x, 0, x - r.right);
        const dy = Math.max(r.top - y, 0, y - r.bottom);
        const d = dx * dx + dy * dy;
        if (d < best) [best, target] = [d, ev];
      }
      let q = start;
      for (const ev of visibleChars(math)) {
        if (ev.math) continue;
        const idx = findInTex(ev.ch, q, start, end);
        if (target && ev.node === target.node && ev.i === target.i) {
          if (idx >= 0) q = idx; // курсор встаёт перед нажатым символом
          break;
        }
        if (idx >= 0) q = idx + 1;
      }
      if (!isDisplayMath(math)) lineTop = math.getBoundingClientRect().top;
      else if (target) lineTop = charRect(target.node, target.i).top;
      return { pos: q, lineTop };
    }

    let p = Number(blk.dataset.s);
    const end = Number(blk.dataset.e);
    for (const ev of visibleChars(blk)) {
      if (ev.math) {
        if (reached(ev.math, 0)) break;
        p = Number(ev.math.dataset.e);
        continue;
      }
      if (reached(ev.node, ev.i)) break;
      const idx = findInSource(ev.ch, p, Math.min(end, nextMathStart(p)));
      if (idx >= 0) p = idx + 1;
    }
    return { pos: p, lineTop };
  }

  /** Позиция в исходном тексте → верх соответствующей строки просмотра на экране (или null). */
  function previewTopForSource(pos) {
    const blocks = [...preview.querySelectorAll('.blk')];
    if (!blocks.length) return null;
    const blk = blocks.find((b) => pos < Number(b.dataset.e)) || blocks[blocks.length - 1];
    if (pos <= Number(blk.dataset.s)) return blk.getBoundingClientRect().top;
    let p = Number(blk.dataset.s);
    const end = Number(blk.dataset.e);
    let last = null; // последний найденный символ: если курсор стоит сразу после него, берём его строку
    for (const ev of visibleChars(blk)) {
      if (ev.math) {
        const me = Number(ev.math.dataset.e);
        if (pos < me) return mathTopForSource(ev.math, pos);
        p = me;
        last = { idx: me - 1, top: ev.math.getBoundingClientRect().top };
        continue;
      }
      const idx = findInSource(ev.ch, p, Math.min(end, nextMathStart(p)));
      if (idx < 0) continue;
      if (idx >= pos) return last && last.idx === pos - 1 ? last.top : charRect(ev.node, ev.i).top;
      p = idx + 1;
      last = { idx, top: charRect(ev.node, ev.i).top };
    }
    return last ? last.top : blk.getBoundingClientRect().top;
  }

  function mathTopForSource(math, pos) {
    const box = math.getBoundingClientRect().top;
    if (!isDisplayMath(math)) return box;
    const { start, end } = mathBounds(math);
    let q = start;
    for (const ev of visibleChars(math)) {
      if (ev.math) continue;
      const idx = findInTex(ev.ch, q, start, end);
      if (idx < 0) continue;
      if (idx >= pos) return charRect(ev.node, ev.i).top;
      q = idx + 1;
    }
    return box;
  }

  /** Высота курсора в поле ввода от верха содержимого: невидимая копия поля с тем же шрифтом и шириной. */
  function caretTop(ta, pos) {
    const cs = getComputedStyle(ta);
    const div = document.createElement('div');
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
      'wordSpacing', 'tabSize', 'textIndent', 'paddingTop', 'paddingLeft', 'paddingRight']) {
      div.style[k] = cs[k];
    }
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    Object.assign(div.style, {
      position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', boxSizing: 'content-box',
      width: `${ta.clientWidth - padX}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    });
    div.textContent = ta.value.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = ta.value.slice(pos, pos + 1) || '.';
    div.appendChild(mark);
    document.body.appendChild(div);
    const top = mark.offsetTop;
    div.remove();
    return top;
  }

  /**
   * Markdown с формулами. Формулы вынимаются до разбора Markdown (иначе он портит знаки _ и \) и
   * запоминаются вместе с местом в исходнике. Каждый блок помечается своим участком исходника.
   */
  function renderMarkdown(src) {
    renderedMath = [];
    if (!window.marked) return `<div class="blk" data-s="0" data-e="${src.length}"><pre>${escapeHtml(src)}</pre></div>`;
    let shift = 0; // на сколько текст с заменителями формул короче исходного
    const re = /\$\$([\s\S]+?)\$\$|(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g;
    const prot = src.replace(re, (m, dtex, pre, itex, off) => {
      const display = dtex !== undefined;
      const s = display ? off : off + pre.length;
      const e = off + m.length;
      const ph = `${renderedMath.length}`;
      renderedMath.push({ tex: display ? dtex : itex, display, s, e, q: s - shift, ph });
      shift += e - s - ph.length;
      return (display ? '' : pre) + ph;
    });
    const toOrig = (x) => {
      let d = 0;
      for (const m of renderedMath) if (m.q < x) d += m.e - m.s - m.ph.length;
      return x + d;
    };
    const tokens = window.marked.lexer(prot);
    let cur = 0;
    let html = '';
    for (const t of tokens) {
      const at = prot.indexOf(t.raw, cur);
      const qs = at >= 0 ? at : cur;
      cur = qs + t.raw.length;
      if (t.type === 'space' || t.type === 'def') continue;
      const one = [t];
      one.links = tokens.links;
      const body = window.marked.parser(one).replace(/(\d+)/g, (_, i) => mathHtml(renderedMath[Number(i)]));
      html += `<div class="blk" data-s="${toOrig(qs)}" data-e="${toOrig(cur)}">${body}</div>`;
    }
    return html;
  }
  function mathHtml({ tex, display, s, e }) {
    const inner = window.katex
      ? window.katex.renderToString(tex, { displayMode: display, throwOnError: false })
      : escapeHtml(display ? `$$${tex}$$` : `$${tex}$`);
    return `<span class="m" data-s="${s}" data-e="${e}" data-d="${display ? 2 : 1}">${inner}</span>`;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  // ── Фото страницы: масштаб двумя пальцами, колесом мыши или двойным нажатием; перемещение пальцем ──
  const pane = $('photo-pane');
  const img = $('photo-img');
  const view = { scale: 1, min: 1, x: 0, y: 0 };
  const pointers = new Map();
  let tap = null; // текущее касание одним пальцем
  let lastTap = null; // предыдущее короткое касание
  let pinch = null;

  function photoUrl(name) {
    if (!photoUrls.has(name)) {
      const job = encodeURIComponent(draft.photosJob || '');
      const load = fetch(`/api/jobs/${job}/photos/${encodeURIComponent(name)}`, { headers: authHeader() })
        .then(async (res) => {
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Сервер ответил кодом ${res.status}`);
          return URL.createObjectURL(await res.blob());
        })
        .catch((e) => {
          photoUrls.delete(name); // при следующем показе попробуем ещё раз
          throw e;
        });
      photoUrls.set(name, load);
    }
    return photoUrls.get(name);
  }
  function forgetPhotos() {
    for (const p of photoUrls.values()) p.then(URL.revokeObjectURL, () => {});
    photoUrls.clear();
  }

  function photoMessage(text) {
    $('photo-msg').textContent = text || '';
    $('photo-msg').hidden = !text;
  }

  async function showPhoto(name) {
    img.hidden = true;
    if (!name || !draft.photosJob) return photoMessage('Фото для этой страницы нет');
    photoMessage('Загружаю фото…');
    try {
      const url = await photoUrl(name);
      if (currentPage().photo !== name) return; // пока грузилось, выбрали другую страницу
      img.onload = () => {
        photoMessage('');
        img.hidden = false;
        fitPhoto();
      };
      img.src = url;
    } catch (e) {
      if (currentPage().photo === name) photoMessage(`Фото не загрузилось: ${e.message}`);
    }
  }

  function fitPhoto() {
    if (!img.naturalWidth) return;
    img.style.width = `${img.naturalWidth}px`;
    img.style.height = `${img.naturalHeight}px`;
    view.min = Math.min(pane.clientWidth / img.naturalWidth, pane.clientHeight / img.naturalHeight);
    view.scale = view.min;
    applyView();
  }

  /** Не даёт увести фото за край: если оно меньше окна — стоит по центру, если больше — без пустых полос. */
  function applyView() {
    const w = img.naturalWidth * view.scale;
    const h = img.naturalHeight * view.scale;
    const W = pane.clientWidth;
    const H = pane.clientHeight;
    view.x = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, view.x));
    view.y = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, view.y));
    img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  function zoomAt(cx, cy, scale) {
    const s = Math.min(view.min * 8, Math.max(view.min, scale));
    view.x = cx - ((cx - view.x) * s) / view.scale;
    view.y = cy - ((cy - view.y) * s) / view.scale;
    view.scale = s;
    applyView();
  }

  const localPoint = (e) => {
    const r = pane.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  }

  pane.addEventListener('pointerdown', (e) => {
    if (img.hidden) return;
    pane.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, localPoint(e));
    if (pointers.size === 2) pinch = pinchState();
    const p = localPoint(e);
    tap = pointers.size === 1 ? { ...p, t: Date.now() } : null;
    // Двойное нажатие: второе короткое касание рядом с первым — приблизить или вернуть фото целиком.
    if (tap && lastTap && tap.t - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      zoomAt(p.x, p.y, view.scale > view.min * 1.05 ? view.min : view.min * 2.5);
      tap = null;
      lastTap = null;
    }
  });
  pane.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const next = localPoint(e);
    pointers.set(e.pointerId, next);
    if (pointers.size === 1) {
      view.x += next.x - prev.x;
      view.y += next.y - prev.y;
      applyView();
    } else if (pointers.size === 2 && pinch) {
      const now = pinchState();
      view.x += now.cx - pinch.cx;
      view.y += now.cy - pinch.cy;
      zoomAt(now.cx, now.cy, (view.scale * now.dist) / pinch.dist);
      pinch = now;
    }
  });
  const dropPointer = (e) => {
    const p = localPoint(e);
    // Короткое касание без движения запоминаем: оно может оказаться первым из двойного нажатия.
    lastTap = tap && Date.now() - tap.t < 250 && Math.hypot(p.x - tap.x, p.y - tap.y) < 10 ? tap : null;
    tap = null;
    pointers.delete(e.pointerId);
    pinch = pointers.size === 2 ? pinchState() : null;
  };
  pane.addEventListener('pointerup', dropPointer);
  pane.addEventListener('pointercancel', dropPointer);
  pane.addEventListener(
    'wheel',
    (e) => {
      if (img.hidden) return;
      e.preventDefault();
      const { x, y } = localPoint(e);
      zoomAt(x, y, view.scale * Math.exp(-e.deltaY / 300));
    },
    { passive: false },
  );
  // Клавиатура или поворот телефона меняют размер половины с фото — вписываем фото заново.
  new ResizeObserver(() => !img.hidden && fitPhoto()).observe(pane);

  // ── Список фото: полумесяц слева, открывается нажатием или свайпом вправо ──
  function renderPageList() {
    const list = $('page-list');
    list.innerHTML = '';
    pages().forEach((p, i) => {
      const li = document.createElement('li');
      li.dataset.i = String(i);
      const first = (p.text.split('\n').find((l) => l.trim()) || 'пусто').replace(/[#*$_`>]/g, '').trim();
      li.innerHTML = '<div class="thumb"></div><div class="info"><b></b><span></span></div>';
      li.querySelector('b').textContent = `Страница ${i + 1}`;
      li.querySelector('span').textContent = first;
      if (p.photo && draft.photosJob) {
        photoUrl(p.photo).then((url) => (li.querySelector('.thumb').style.backgroundImage = `url("${url}")`), () => {});
      }
      li.addEventListener('click', () => {
        selectPage(i);
        setDrawer(false);
      });
      list.appendChild(li);
    });
    markActivePage();
  }
  function markActivePage() {
    for (const li of $('page-list').children) li.classList.toggle('active', Number(li.dataset.i) === pageIndex);
  }

  const drawerOpen = () => $('step-edit').classList.contains('drawer-open');
  function setDrawer(open) {
    if (open && mode === 'edit') enterRead();
    if (open) renderPageList(); // первая строка в списке — по свежему тексту
    $('step-edit').classList.toggle('drawer-open', open);
  }

  let swipe = null;
  $('step-edit').addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      const fromEdge = t.clientX < 28 || e.target.closest('#drawer-tab');
      swipe = e.touches.length === 1 && (fromEdge || drawerOpen()) ? { x: t.clientX, y: t.clientY } : null;
    },
    { passive: true },
  );
  $('step-edit').addEventListener(
    'touchmove',
    (e) => {
      if (!swipe) return;
      const t = e.touches[0];
      const dx = t.clientX - swipe.x;
      if (Math.abs(t.clientY - swipe.y) > Math.abs(dx)) return;
      if (!drawerOpen() && dx > 40) {
        setDrawer(true);
        swipe = null;
      } else if (drawerOpen() && dx < -40) {
        setDrawer(false);
        swipe = null;
      }
    },
    { passive: true },
  );

  // ── Сохранение ────────────────────────────────────────────
  /** Страницы склеиваются в одну запись через пустую строку. */
  function fullText() {
    return pages()
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  function alertUser(message) {
    if (tg && tg.initData && tg.showAlert) tg.showAlert(message);
    else alert(message);
  }

  let saving = false;
  async function save() {
    if (saving) return;
    if (mode === 'edit') syncEditor();
    saving = true;
    const btn = $('save-fallback-btn');
    btn.disabled = true;
    btn.textContent = 'Сохраняю…';
    if (useMainButton) tg.MainButton.showProgress(false);
    try {
      const { path } = await api('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          semester: draft.semester,
          subject: draft.subject,
          date: draft.date,
          topic: draft.topic,
          text: fullText(),
        }),
      });
      $('saved-path').textContent = path;
      clearDraft();
      resetPhotos();
      forgetPhotos();
      setDrawer(false);
      show('done');
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    } catch (e) {
      alertUser(`Не сохранилось: ${e.message}`);
    } finally {
      saving = false;
      btn.disabled = false;
      btn.textContent = 'Сохранить в репозиторий';
      if (useMainButton) tg.MainButton.hideProgress();
    }
  }

  function resetPhotos() {
    for (const p of photos) URL.revokeObjectURL(p.url);
    photos = [];
    renderPhotos();
  }

  function restart() {
    const ask = 'Начать заново? Распознанный текст будет потерян.';
    const go = () => {
      delete draft.pages;
      delete draft.photosJob;
      delete draft.page;
      saveDraft();
      forgetPhotos();
      setDrawer(false);
      show('form');
    };
    if (tg && tg.initData && tg.showConfirm) tg.showConfirm(ask, (ok) => ok && go());
    else if (confirm(ask)) go();
  }

  // ── Обработчики ───────────────────────────────────────────
  $('semester').addEventListener('change', () => {
    draft.semester = $('semester').value;
    delete draft.subject;
    fillSubjects();
    rememberForm();
  });
  $('subject').addEventListener('change', () => {
    $('new-subject-field').hidden = $('subject').value !== NEW_SUBJECT;
    if ($('subject').value === NEW_SUBJECT) $('new-subject').focus();
    rememberForm();
  });
  for (const id of ['new-subject', 'date', 'topic']) $(id).addEventListener('input', rememberForm);
  $('photo-input').addEventListener('change', (e) => {
    for (const file of e.target.files) photos.push({ file, url: URL.createObjectURL(file) });
    e.target.value = '';
    renderPhotos();
  });
  $('recognize-btn').addEventListener('click', startRecognition);
  $('wait-back-btn').addEventListener('click', () => show('form'));

  preview.addEventListener('click', (e) => {
    e.preventDefault(); // ссылки в просмотре не открываем: нажатие означает «править здесь»
    enterEdit(e.clientX, e.clientY);
  });
  $('mode-btn').addEventListener('pointerdown', (e) => e.preventDefault()); // не снимать фокус с поля раньше времени
  $('mode-btn').addEventListener('click', () => {
    if (mode === 'edit') return enterRead();
    const r = preview.getBoundingClientRect();
    enterEdit(r.left + 20, r.top + 12);
  });
  editor.addEventListener('input', syncEditor);
  window.addEventListener('resize', keepCaretVisible);
  if (tg) tg.onEvent('viewportChanged', keepCaretVisible);
  $('drawer-tab').addEventListener('click', () => setDrawer(!drawerOpen()));
  $('drawer-backdrop').addEventListener('click', () => setDrawer(false));
  $('save-fallback-btn').addEventListener('click', save);
  if (useMainButton) tg.MainButton.setText('Сохранить в репозиторий').onClick(save);
  $('restart-btn').addEventListener('click', restart);
  $('new-btn').addEventListener('click', () => show('form'));

  // ── Запуск ────────────────────────────────────────────────
  async function init() {
    $('date').value = draft.date || today();
    $('topic').value = draft.topic || '';
    try {
      tree = (await api('/api/tree')).semesters;
    } catch (e) {
      setError('form-error', `Не удалось получить список предметов: ${e.message}`);
    }
    fillSemesters();

    if (draft.jobId) pollJob();
    else if (pages().length) openEditor();
    else show('form');
  }
  init();
})();
