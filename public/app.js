// Mini App: выбор семестра и предмета, загрузка фото, ожидание распознавания, правка и сохранение текста.
// Черновик (поля формы, номер задания, текст) хранится в localStorage, поэтому свёрнутое или закрытое
// приложение при повторном открытии продолжает с того же места. Сами фото не хранятся.
(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  const $ = (id) => document.getElementById(id);
  const DRAFT_KEY = 'textrec-draft-v1';
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
        draft.text = job.text;
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
  function openEditor() {
    $('editor').value = draft.text || '';
    const topic = draft.topic ? ` · ${draft.topic}` : '';
    $('target').textContent = `${draft.semester} семестр / ${draft.subject} / Записи · ${draft.date}${topic}`;
    setTab('editor');
    setError('edit-error', '');
    show('edit');
  }

  function setTab(tab) {
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
    $('editor').hidden = tab !== 'editor';
    $('preview').hidden = tab !== 'preview';
    if (tab === 'preview') $('preview').innerHTML = renderMarkdown($('editor').value);
  }

  /** Markdown с формулами: формулы вынимаются до разбора Markdown, иначе он портит знаки _ и \. */
  function renderMarkdown(src) {
    if (!window.marked) return `<pre>${escapeHtml(src)}</pre>`;
    const math = [];
    const keep = (tex, display) => {
      math.push({ tex, display });
      return `\u0000M${math.length - 1}\u0000`;
    };
    const protectedSrc = src
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => keep(t, true))
      .replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_, pre, t) => pre + keep(t, false));
    let html = window.marked.parse(protectedSrc, { breaks: true });
    html = html.replace(/\u0000M(\d+)\u0000/g, (_, i) => {
      const { tex, display } = math[Number(i)];
      if (!window.katex) return escapeHtml(display ? `$$${tex}$$` : `$${tex}$`);
      return window.katex.renderToString(tex, { displayMode: display, throwOnError: false });
    });
    return html;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  async function save() {
    setError('edit-error', '');
    const btn = $('save-btn');
    btn.disabled = true;
    btn.textContent = 'Сохраняю…';
    try {
      const { path } = await api('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          semester: draft.semester,
          subject: draft.subject,
          date: draft.date,
          topic: draft.topic,
          text: $('editor').value,
        }),
      });
      $('saved-path').textContent = path;
      clearDraft();
      resetPhotos();
      show('done');
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    } catch (e) {
      setError('edit-error', e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Сохранить в репозиторий';
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
      delete draft.text;
      saveDraft();
      show('form');
    };
    if (tg && tg.showConfirm) tg.showConfirm(ask, (ok) => ok && go());
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
  $('editor').addEventListener('input', () => {
    draft.text = $('editor').value;
    saveDraft();
  });
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('save-btn').addEventListener('click', save);
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
    else if (draft.text) openEditor();
    else show('form');
  }
  init();
})();
