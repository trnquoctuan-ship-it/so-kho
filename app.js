'use strict';

/* =========================================================
   Sổ Kho – quản lý nhập / xuất / tồn kho bằng IndexedDB
   Không cần máy chủ. Ảnh lưu dạng blob trong IndexedDB.
   ========================================================= */

/* ---------------- tiện ích ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s = '') => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const norm = s => (s || '')
  .toString()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd')
  .trim();

const round = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const fmt = n => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(round(n || 0));
const fmtMoney = n => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(n || 0) + ' đ';

const uid = () => (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

const pad = n => String(n).padStart(2, '0');
const localDT = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const timeHM = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dateShort = ts => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
const WEEKDAYS = ['CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((a - b) / 86400000);
  if (diff === 0) return 'Hôm nay';
  if (diff === 1) return 'Hôm qua';
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function initials(name) {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] || '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/* ---------------- IndexedDB ---------------- */
const DB_NAME = 'so-kho-db';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB không được hỗ trợ')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('products')) d.createObjectStore('products', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('transactions')) {
        const s = d.createObjectStore('transactions', { keyPath: 'id' });
        s.createIndex('productId', 'productId', { unique: false });
        s.createIndex('ts', 'ts', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function db() {
  if (_db) return Promise.resolve(_db);
  return openDB().then(d => { _db = d; return d; });
}

function idbGetAll(store) {
  return db().then(d => new Promise((resolve, reject) => {
    const r = d.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  }));
}

function idbGet(store, key) {
  return db().then(d => new Promise((resolve, reject) => {
    const r = d.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function idbPut(store, value) {
  return db().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

function idbDelete(store, key) {
  return db().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  }));
}

function idbClear(store) {
  return db().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  }));
}

/* ---------------- trạng thái ---------------- */
const state = {
  tab: 'stock',
  products: [],
  txs: [],
  stock: new Map(),
  stockSearch: '',
  stockFilter: 'all',
  historyType: 'all',
  historySearch: '',
  sel: { in: null, out: null },
  pickerTarget: null,
  editingId: null,
  imageDraft: null,       // Blob | 'remove' | null
  draftUrl: null,
  detailId: null,
};

const imageCache = new Map(); // imageId -> objectURL
let confirmResolve = null;
let toastTimer = null;
let pendingImage = null;
let productSession = 0;

/* ---------------- dữ liệu ---------------- */
function productById(id) {
  return state.products.find(p => p.id === id) || null;
}

function stockOf(id) {
  return round(state.stock.get(id) || 0);
}

function isLow(p) {
  const min = Number(p.minStock) || 0;
  return min > 0 && stockOf(p.id) > 0 && stockOf(p.id) <= min;
}

function isOut(p) {
  return stockOf(p.id) <= 0;
}

function recomputeStock() {
  const map = new Map();
  for (const t of state.txs) {
    const prev = map.get(t.productId) || 0;
    map.set(t.productId, prev + (t.type === 'in' ? Number(t.qty) : -Number(t.qty)));
  }
  for (const [k, v] of map) map.set(k, round(v));
  state.stock = map;
}

function preloadImages() {
  for (const url of imageCache.values()) URL.revokeObjectURL(url);
  imageCache.clear();
  return idbGetAll('images').then(list => {
    for (const rec of list) {
      if (rec && rec.blob) imageCache.set(rec.id, URL.createObjectURL(rec.blob));
    }
  });
}

async function loadAll() {
  const [products, txs] = await Promise.all([idbGetAll('products'), idbGetAll('transactions')]);
  state.products = products;
  state.txs = txs;
  await preloadImages();
  recomputeStock();
}

async function refresh() {
  await loadAll();
  renderStock();
  renderHistory();
  renderFormState('in');
  renderFormState('out');
  if (state.detailId && !$('#detailModal').hidden) renderDetail();
  updateStorageText();
}

/* ---------------- hiển thị ảnh ---------------- */
function thumbInner(p) {
  const url = p && p.imageId ? imageCache.get(p.imageId) : null;
  if (url) return `<img src="${url}" alt="${esc(p.name)}" loading="lazy">`;
  return `<span class="thumb-letter">${esc(initials(p ? p.name : '?'))}</span>`;
}

/* ---------------- render: tồn kho ---------------- */
function renderStock() {
  const q = norm(state.stockSearch);
  const counts = new Map();
  for (const t of state.txs) counts.set(t.productId, (counts.get(t.productId) || 0) + 1);

  let list = state.products.slice().sort((a, b) => a.name.localeCompare(b.name, 'vi'));

  const totalStock = state.products.reduce((sum, p) => sum + Math.max(0, stockOf(p.id)), 0);
  const lowCount = state.products.filter(isLow).length;

  $('#statProducts').textContent = fmt(state.products.length);
  $('#statTotal').textContent = fmt(totalStock);
  $('#statLow').textContent = fmt(lowCount);

  if (q) list = list.filter(p => norm(p.name).includes(q) || norm(p.note).includes(q));
  if (state.stockFilter === 'low') list = list.filter(isLow);
  if (state.stockFilter === 'empty') list = list.filter(isOut);

  const wrap = $('#stockList');
  wrap.innerHTML = list.map(p => {
    const s = stockOf(p.id);
    const low = isLow(p);
    const out = isOut(p);
    const n = counts.get(p.id) || 0;
    const unit = esc(p.unit || '');
    return `
    <article class="p-card${low || out ? ' low' : ''}" data-id="${esc(p.id)}">
      <button class="p-thumb" data-act="open" aria-label="Xem ${esc(p.name)}">${thumbInner(p)}</button>
      <div class="p-main" data-act="open">
        <div class="p-name">${esc(p.name)}</div>
        <div class="p-meta">
          ${out ? '<span class="badge red">Hết hàng</span>' : low ? '<span class="badge">Sắp hết</span>' : ''}
          <span>${n} giao dịch</span>
          ${p.note ? `<span class="p-note">· ${esc(p.note)}</span>` : ''}
        </div>
      </div>
      <div class="p-side">
        <div class="p-stock">
          <strong class="${s < 0 ? 'neg' : ''}">${fmt(s)}</strong>
          <span>${unit}</span>
        </div>
        <div class="p-quick">
          <button class="q-btn in" data-act="in" title="Nhập kho" aria-label="Nhập kho ${esc(p.name)}"><svg class="ico"><use href="#i-plus"/></svg></button>
          <button class="q-btn out" data-act="out" title="Xuất kho" aria-label="Xuất kho ${esc(p.name)}"><svg class="ico"><use href="#i-minus"/></svg></button>
        </div>
      </div>
    </article>`;
  }).join('');

  const empty = $('#stockEmpty');
  const noneAtAll = state.products.length === 0;
  if (!list.length) {
    empty.hidden = false;
    $('#emptyTitle').textContent = noneAtAll ? 'Chưa có hàng hóa nào' : 'Không tìm thấy hàng hóa';
    $('#emptyDesc').textContent = noneAtAll
      ? 'Chụp ảnh và thêm mặt hàng đầu tiên để bắt đầu ghi sổ kho.'
      : 'Thử từ khóa khác hoặc bỏ bộ lọc đang chọn.';
    $('#emptyAdd').hidden = !noneAtAll;
  } else {
    empty.hidden = true;
  }

  $$('#stockChips .chip').forEach(c => c.classList.toggle('active', c.dataset.sfilter === state.stockFilter));
}

/* ---------------- render: lịch sử ---------------- */
function filteredTxs() {
  let list = state.txs.slice().sort((a, b) => b.ts - a.ts);
  if (state.historyType !== 'all') list = list.filter(t => t.type === state.historyType);
  const q = norm(state.historySearch);
  if (q) {
    list = list.filter(t => {
      const p = productById(t.productId);
      return norm(p ? p.name : '').includes(q) || norm(t.note || '').includes(q);
    });
  }
  return list;
}

function renderHistory() {
  const list = filteredTxs();
  const tin = list.filter(t => t.type === 'in').length;
  const tout = list.length - tin;

  $('#historySummary').textContent = list.length
    ? `${list.length} phiếu · ${tin} nhập · ${tout} xuất`
    : (state.txs.length ? 'Không có phiếu phù hợp bộ lọc' : 'Toàn bộ phiếu nhập và xuất');

  const groups = new Map();
  for (const t of list) {
    const k = dayLabel(t.ts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  $('#historyList').innerHTML = Array.from(groups.entries()).map(([label, items]) => `
    <div class="h-group">
      <div class="h-group-title">${esc(label)}</div>
      ${items.map(t => {
        const p = productById(t.productId);
        const name = p ? p.name : 'Hàng hóa đã xóa';
        const unit = p ? p.unit : '';
        return `
        <div class="h-row" data-pid="${esc(t.productId)}">
          <div class="h-thumb">${p ? thumbInner(p) : '?'}</div>
          <div class="h-main" data-act="open-tx">
            <div class="h-name">${esc(name)}</div>
            <div class="h-sub">${timeHM(t.ts)}${t.type === 'in' && t.price ? ' · ' + fmtMoney(t.price) : ''}${t.note ? ' · ' + esc(t.note) : ''}</div>
          </div>
          <div class="h-qty ${t.type}">${t.type === 'in' ? '+' : '−'}${fmt(t.qty)} <span>${esc(unit)}</span></div>
          <button class="h-del" data-del="${esc(t.id)}" title="Xóa phiếu" aria-label="Xóa phiếu"><svg class="ico"><use href="#i-trash"/></svg></button>
        </div>`;
      }).join('')}
    </div>`).join('');

  $('#historyEmpty').hidden = list.length > 0;
  $$('#historyChips .chip').forEach(c => c.classList.toggle('active', c.dataset.htype === state.historyType));
}

/* ---------------- render: form nhập/xuất ---------------- */
function renderFormState(type) {
  const p = productById(state.sel[type]);
  const thumb = $(`[data-pickthumb="${type}"]`);
  const name = $(`[data-pickname="${type}"]`);

  if (thumb) {
    thumb.innerHTML = p ? thumbInner(p) : '?';
  }
  if (name) {
    name.textContent = p ? p.name : 'Chọn hàng hóa';
    name.classList.toggle('placeholder', !p);
  }
  updatePreview(type);
}

function updatePreview(type) {
  const el = $(`#${type}Preview`);
  if (!el) return;
  const p = productById(state.sel[type]);
  if (!p) {
    el.className = 'preview empty-state';
    el.textContent = 'Chọn hàng hóa để xem tồn kho';
    return;
  }
  const raw = parseFloat($(`#${type}Qty`).value);
  const qty = Number.isFinite(raw) ? raw : 0;
  const cur = stockOf(p.id);
  const after = round(cur + (type === 'in' ? qty : -qty));
  el.className = 'preview';
  el.innerHTML = `
    <span>Tồn hiện tại: <b>${fmt(cur)}</b> ${esc(p.unit || '')}</span>
    <span class="${after < 0 ? 'neg' : ''}">Sau khi ${type === 'in' ? 'nhập' : 'xuất'}: <b>${fmt(after)}</b> ${esc(p.unit || '')}</span>`;
}

/* ---------------- điều hướng tab ---------------- */
const TABS = ['stock', 'in', 'out', 'history'];

function switchTab(tab, updateHash = true) {
  if (!TABS.includes(tab)) tab = 'stock';
  state.tab = tab;
  $$('.tab-panel').forEach(el => { el.hidden = el.id !== 'tab-' + tab; });
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (updateHash) {
    try {
      if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
    } catch (e) { /* bỏ qua */ }
  }
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  if (tab === 'history') renderHistory();
}

/* ---------------- modal ---------------- */
function showModal(sel) {
  const m = $(sel);
  if (!m) return;
  m.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => m.classList.add('open'));
}

function closeModal(sel) {
  const m = $(sel);
  if (!m) return;
  m.classList.remove('open');
  setTimeout(() => {
    m.hidden = true;
    if (!$$('.modal:not([hidden])').length) document.body.classList.remove('modal-open');
  }, 210);
}

function confirmDialog({ title, message, confirmText = 'Đồng ý', cancelText = 'Hủy', danger = false }) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    $('#cfTitle').textContent = title;
    $('#cfMsg').textContent = message;
    $('#cfOk').textContent = confirmText;
    $('#cfCancel').textContent = cancelText;
    $('#cfOk').classList.toggle('danger', danger);
    $('#cfOk').classList.toggle('primary', !danger);
    showModal('#confirmModal');
  });
}

function settleConfirm(value) {
  const resolve = confirmResolve;
  confirmResolve = null;
  closeModal('#confirmModal');
  if (resolve) resolve(value);
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------------- ảnh ---------------- */
function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Không đọc được ảnh')); };
    img.src = url;
  });
}

async function compressImage(file) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch (e) {
    source = await loadImageElement(file);
  }
  const maxSide = 1100;
  const w0 = source.width || 800;
  const h0 = source.height || 800;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  if (source.close) source.close();

  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
  return blob || file;
}

function setDraftImage(blob) {
  if (state.draftUrl) URL.revokeObjectURL(state.draftUrl);
  state.imageDraft = blob;
  state.draftUrl = URL.createObjectURL(blob);
  renderPhotoPreview(productById(state.editingId));
}

function clearDraftImage() {
  if (state.draftUrl) URL.revokeObjectURL(state.draftUrl);
  state.imageDraft = 'remove';
  state.draftUrl = null;
  renderPhotoPreview(productById(state.editingId));
}

function renderPhotoPreview(p) {
  const el = $('#pmPreview');
  if (!el) return;
  let url = null;
  if (state.imageDraft && state.imageDraft !== 'remove') url = state.draftUrl;
  else if (!state.imageDraft && p && p.imageId) url = imageCache.get(p.imageId) || null;

  el.innerHTML = url
    ? `<img src="${url}" alt="Ảnh hàng hóa">`
    : '<span>Chưa có ảnh</span>';

  const removeBtn = $('#pmRemoveImg');
  if (removeBtn) removeBtn.hidden = !url;
}

async function handleImageFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('File không phải là ảnh', 'error'); return; }

  const session = productSession;
  const task = (async () => {
    toast('Đang xử lý ảnh...');
    const blob = await compressImage(file);
    if (session !== productSession) return;
    setDraftImage(blob);
    toast('Đã thêm ảnh');
  })();

  pendingImage = task;
  try {
    await task;
  } catch (e) {
    console.error(e);
    toast('Không xử lý được ảnh này', 'error');
  } finally {
    if (pendingImage === task) pendingImage = null;
  }
}

/* ---------------- hàng hóa ---------------- */
function resetProductDraft() {
  productSession++;
  if (state.draftUrl) { URL.revokeObjectURL(state.draftUrl); state.draftUrl = null; }
  state.imageDraft = null;
  state.editingId = null;
}

function openProductModal(id = null) {
  productSession++;
  state.editingId = id;
  state.imageDraft = null;
  if (state.draftUrl) { URL.revokeObjectURL(state.draftUrl); state.draftUrl = null; }

  const p = id ? productById(id) : null;
  $('#pmTitle').textContent = p ? 'Sửa hàng hóa' : 'Thêm hàng hóa';
  $('#pmName').value = p ? p.name : '';
  $('#pmUnit').value = p ? (p.unit || 'cái') : 'cái';
  $('#pmMin').value = p && p.minStock ? p.minStock : '';
  $('#pmNote').value = p ? (p.note || '') : '';
  $('#pmOpening').value = '';
  $('#pmOpeningField').hidden = !!p;
  $('#pmRemoveImg').hidden = !(p && p.imageId);
  renderPhotoPreview(p);

  showModal('#productModal');
  setTimeout(() => { try { $('#pmName').focus(); } catch (e) {} }, 260);
}

async function saveProduct() {
  if (pendingImage) { try { await pendingImage; } catch (e) { /* đã báo lỗi */ } }

  const name = $('#pmName').value.trim();
  if (!name) { toast('Vui lòng nhập tên hàng hóa'); $('#pmName').focus(); return; }

  const existing = state.products.find(p => norm(p.name) === norm(name) && p.id !== state.editingId);
  if (existing) {
    const go = await confirmDialog({
      title: 'Tên hàng đã tồn tại',
      message: `Đã có hàng hóa "${existing.name}". Bạn vẫn muốn tạo mặt hàng mới với tên này?`,
      confirmText: 'Vẫn tạo',
    });
    if (!go) return;
  }

  try {
    const isNew = !state.editingId;
    const base = isNew ? { id: uid(), createdAt: Date.now() } : Object.assign({}, productById(state.editingId));
    const oldImageId = base.imageId;

    base.name = name;
    base.unit = $('#pmUnit').value.trim() || 'cái';
    base.minStock = Math.max(0, Number($('#pmMin').value) || 0);
    base.note = $('#pmNote').value.trim();
    base.updatedAt = Date.now();

    if (state.imageDraft && state.imageDraft !== 'remove') {
      const imgId = uid();
      await idbPut('images', { id: imgId, blob: state.imageDraft, createdAt: Date.now() });
      base.imageId = imgId;
    } else if (state.imageDraft === 'remove') {
      delete base.imageId;
    }

    await idbPut('products', base);
    if (oldImageId && oldImageId !== base.imageId) {
      await idbDelete('images', oldImageId).catch(() => {});
    }

    const opening = Math.max(0, Number($('#pmOpening').value) || 0);
    if (isNew && opening > 0) {
      await idbPut('transactions', {
        id: uid(),
        productId: base.id,
        type: 'in',
        qty: opening,
        price: 0,
        note: 'Tồn đầu kỳ',
        ts: Date.now(),
        createdAt: Date.now(),
      });
    }

    if (state.draftUrl) { URL.revokeObjectURL(state.draftUrl); state.draftUrl = null; }
    state.imageDraft = null;
    state.editingId = null;
    closeModal('#productModal');

    const target = state.pickerTarget;
    if (isNew && target) state.sel[target] = base.id;

    await refresh();
    if (target) { renderFormState(target); updatePreview(target); }
    toast(isNew ? `Đã thêm "${base.name}"` : 'Đã lưu thay đổi');
  } catch (e) {
    console.error(e);
    toast('Không lưu được hàng hóa', 'error');
  }
}

async function deleteProduct(id) {
  const p = productById(id);
  if (!p) return;
  const related = state.txs.filter(t => t.productId === id).length;
  const ok = await confirmDialog({
    title: 'Xóa hàng hóa?',
    message: `"${p.name}"${related ? ` và ${related} phiếu nhập/xuất liên quan` : ''} sẽ bị xóa vĩnh viễn. Bạn không thể hoàn tác.`,
    confirmText: 'Xóa vĩnh viễn',
    danger: true,
  });
  if (!ok) return;

  try {
    for (const t of state.txs.filter(t => t.productId === id)) {
      await idbDelete('transactions', t.id);
    }
    if (p.imageId) await idbDelete('images', p.imageId).catch(() => {});
    await idbDelete('products', id);

    if (state.sel.in === id) state.sel.in = null;
    if (state.sel.out === id) state.sel.out = null;
    if (state.detailId === id) { state.detailId = null; closeModal('#detailModal'); }

    await refresh();
    toast('Đã xóa hàng hóa');
  } catch (e) {
    console.error(e);
    toast('Không xóa được hàng hóa', 'error');
  }
}

/* ---------------- phiếu nhập / xuất ---------------- */
function startTx(type, id) {
  state.sel[type] = id;
  renderFormState(type);
  switchTab(type);
  const qty = $(`#${type}Qty`);
  qty.value = '';
  updatePreview(type);
  setTimeout(() => {
    try { qty.focus({ preventScroll: true }); } catch (e) { qty.focus(); }
    const form = $(`#form-${type}`);
    if (form) form.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 280);
}

async function saveTx(type) {
  const p = productById(state.sel[type]);
  if (!p) { toast('Hãy chọn hàng hóa'); return; }

  const qtyEl = $(`#${type}Qty`);
  const qty = Number(qtyEl.value);
  if (!Number.isFinite(qty) || qty <= 0) {
    toast('Số lượng phải lớn hơn 0');
    qtyEl.focus();
    return;
  }

  const dateStr = $(`#${type}Date`).value;
  let ts = dateStr ? new Date(dateStr).getTime() : Date.now();
  if (!Number.isFinite(ts)) ts = Date.now();

  const note = $(`#${type}Note`).value.trim();
  const price = type === 'in' ? Math.max(0, Number($('#inPrice').value) || 0) : 0;

  if (type === 'out' && qty > stockOf(p.id)) {
    const ok = await confirmDialog({
      title: 'Xuất vượt tồn kho',
      message: `Tồn hiện tại của "${p.name}" chỉ còn ${fmt(stockOf(p.id))} ${p.unit}. Vẫn lưu phiếu xuất ${fmt(qty)} ${p.unit}?`,
      confirmText: 'Vẫn xuất',
      danger: true,
    });
    if (!ok) return;
  }

  try {
    await idbPut('transactions', {
      id: uid(),
      productId: p.id,
      type,
      qty: round(qty),
      price,
      note,
      ts,
      createdAt: Date.now(),
    });

    qtyEl.value = '';
    $(`#${type}Note`).value = '';
    if (type === 'in') $('#inPrice').value = '';
    setDefaultDates();

    await refresh();
    toast(`${type === 'in' ? 'Đã nhập' : 'Đã xuất'} ${fmt(qty)} ${p.unit} · Tồn: ${fmt(stockOf(p.id))} ${p.unit}`);
    qtyEl.focus();
  } catch (e) {
    console.error(e);
    toast('Không lưu được phiếu', 'error');
  }
}

async function deleteTx(id) {
  const t = state.txs.find(x => x.id === id);
  if (!t) return;
  const p = productById(t.productId);
  const ok = await confirmDialog({
    title: 'Xóa phiếu này?',
    message: `${t.type === 'in' ? 'Phiếu nhập' : 'Phiếu xuất'} ${fmt(t.qty)} ${p ? p.unit : ''} của "${p ? p.name : 'hàng hóa'}" sẽ bị xóa và tồn kho được tính lại.`,
    confirmText: 'Xóa phiếu',
    danger: true,
  });
  if (!ok) return;
  try {
    await idbDelete('transactions', id);
    await refresh();
    toast('Đã xóa phiếu');
  } catch (e) {
    console.error(e);
    toast('Không xóa được phiếu', 'error');
  }
}

/* ---------------- chi tiết hàng hóa ---------------- */
function openDetail(id) {
  if (!productById(id)) return;
  state.detailId = id;
  renderDetail();
  showModal('#detailModal');
}

function renderDetail() {
  const p = productById(state.detailId);
  if (!p) { closeModal('#detailModal'); return; }

  const txs = state.txs.filter(t => t.productId === p.id).sort((a, b) => b.ts - a.ts);
  const tin = round(txs.filter(t => t.type === 'in').reduce((a, t) => a + Number(t.qty), 0));
  const tout = round(txs.filter(t => t.type === 'out').reduce((a, t) => a + Number(t.qty), 0));
  const s = stockOf(p.id);
  const unit = esc(p.unit || '');

  const recent = txs.slice(0, 8).map(t => `
    <div class="mini-tx">
      <span class="t">${dateShort(t.ts)} ${timeHM(t.ts)}</span>
      <span class="n">${t.note ? esc(t.note) : (t.type === 'in' ? 'Nhập kho' : 'Xuất kho')}</span>
      <span class="q ${t.type}">${t.type === 'in' ? '+' : '−'}${fmt(t.qty)} ${unit}</span>
    </div>`).join('');

  $('#detailBody').innerHTML = `
    <div class="detail-hero">
      <div class="detail-photo">${thumbInner(p)}</div>
      <div class="detail-title">
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.unit || '')}${p.note ? ' · ' + esc(p.note) : ''}</p>
        ${isLow(p) || isOut(p)
          ? `<span class="badge ${isOut(p) ? 'red' : ''}" style="margin-top:8px">${isOut(p) ? 'Hết hàng' : 'Sắp hết'}</span>`
          : ''}
      </div>
    </div>

    <div class="stock-hero">
      <strong class="${s < 0 ? 'neg' : ''}">${fmt(s)}</strong>
      <span>${unit}</span>
      <span class="sep">Tồn tối thiểu<br><b>${fmt(Number(p.minStock) || 0)} ${unit}</b></span>
    </div>

    <div class="detail-grid">
      <div class="mini-stat in"><span>Tổng đã nhập</span><strong>+${fmt(tin)} ${unit}</strong></div>
      <div class="mini-stat out"><span>Tổng đã xuất</span><strong>−${fmt(tout)} ${unit}</strong></div>
    </div>

    <div class="detail-actions">
      <button class="btn primary" data-dact="in"><svg class="ico"><use href="#i-plus"/></svg> Nhập</button>
      <button class="btn soft" data-dact="out"><svg class="ico"><use href="#i-minus"/></svg> Xuất</button>
      <button class="btn ghost icon-only" data-dact="edit" title="Sửa"><svg class="ico"><use href="#i-edit"/></svg></button>
      <button class="btn ghost icon-only" data-dact="delete" title="Xóa"><svg class="ico"><use href="#i-trash"/></svg></button>
    </div>

    <div class="detail-section">
      <h4>Giao dịch gần đây</h4>
      ${recent || '<p class="hint">Chưa có giao dịch nào.</p>'}
      ${txs.length > 8 ? '<button class="link-btn" data-dact="all">Xem tất cả ' + txs.length + ' giao dịch →</button>' : ''}
    </div>
  `;
}

/* ---------------- chọn hàng hóa ---------------- */
function openPicker(target) {
  state.pickerTarget = target;
  $('#pickerSearch').value = '';
  renderPickerList();
  showModal('#pickerModal');
  setTimeout(() => { try { $('#pickerSearch').focus(); } catch (e) {} }, 260);
}

function renderPickerList() {
  const q = norm($('#pickerSearch').value);
  const current = state.pickerTarget ? state.sel[state.pickerTarget] : null;
  let list = state.products.slice().sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  if (q) list = list.filter(p => norm(p.name).includes(q));

  if (!list.length) {
    $('#pickerList').innerHTML = `<div class="empty" style="padding:26px 16px">
      <p style="margin-bottom:14px">${state.products.length ? 'Không tìm thấy hàng hóa phù hợp.' : 'Chưa có hàng hóa nào trong kho.'}</p>
      <button class="btn soft" id="pickerNewInline"><svg class="ico"><use href="#i-plus"/></svg> Thêm hàng hóa mới</button>
    </div>`;
    return;
  }

  $('#pickerList').innerHTML = list.map(p => {
    const s = stockOf(p.id);
    return `
    <button class="picker-row${p.id === current ? ' sel' : ''}" data-pick-id="${esc(p.id)}">
      <span class="p-thumb">${thumbInner(p)}</span>
      <span class="picker-info">
        <strong>${esc(p.name)}</strong>
        <small>${isOut(p) ? 'Hết hàng' : 'Tồn kho'}</small>
      </span>
      <span class="picker-stock${isLow(p) || isOut(p) ? ' low' : ''}">${fmt(s)} ${esc(p.unit || '')}</span>
    </button>`;
  }).join('');
}

function selectProduct(target, id) {
  state.sel[target] = id;
  renderFormState(target);
  updatePreview(target);
}

/* ---------------- dữ liệu: sao lưu / khôi phục ---------------- */
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dataURLToBlob(dataUrl) {
  const parts = String(dataUrl).split(',');
  const head = parts[0] || '';
  const b64 = parts[1] || '';
  const mime = (/data:([^;]+)/.exec(head) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function exportData() {
  try {
    const [products, txs, images] = await Promise.all([
      idbGetAll('products'), idbGetAll('transactions'), idbGetAll('images'),
    ]);
    const imgMap = {};
    for (const rec of images) {
      if (rec && rec.blob) imgMap[rec.id] = await blobToDataURL(rec.blob);
    }
    const payload = {
      app: 'so-kho',
      version: 1,
      exportedAt: new Date().toISOString(),
      products,
      transactions: txs,
      images: imgMap,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `so-kho-sao-luu-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Đã xuất file sao lưu');
  } catch (e) {
    console.error(e);
    toast('Không xuất được dữ liệu', 'error');
  }
}

async function importData(file) {
  if (!file) return;
  try {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { toast('File JSON không hợp lệ', 'error'); return; }

    if (!data || !Array.isArray(data.products) || !Array.isArray(data.transactions)) {
      toast('File không đúng định dạng sao lưu', 'error');
      return;
    }

    const ok = await confirmDialog({
      title: 'Khôi phục dữ liệu?',
      message: `File có ${data.products.length} hàng hóa và ${data.transactions.length} giao dịch. Toàn bộ dữ liệu hiện tại sẽ bị thay thế.`,
      confirmText: 'Khôi phục',
      danger: true,
    });
    if (!ok) return;

    await Promise.all(['products', 'transactions', 'images'].map(idbClear));

    for (const p of data.products) {
      if (!p || !p.id || !p.name) continue;
      await idbPut('products', {
        id: String(p.id),
        name: String(p.name),
        unit: p.unit ? String(p.unit) : 'cái',
        minStock: Math.max(0, Number(p.minStock) || 0),
        note: p.note ? String(p.note) : '',
        imageId: p.imageId || undefined,
        createdAt: Number(p.createdAt) || Date.now(),
      });
    }

    for (const t of data.transactions) {
      if (!t || !t.id || !t.productId || (t.type !== 'in' && t.type !== 'out')) continue;
      await idbPut('transactions', {
        id: String(t.id),
        productId: String(t.productId),
        type: t.type,
        qty: Math.max(0, Number(t.qty) || 0),
        price: Math.max(0, Number(t.price) || 0),
        note: t.note ? String(t.note) : '',
        ts: Number(t.ts) || Date.now(),
        createdAt: Number(t.createdAt) || Date.now(),
      });
    }

    const imgs = data.images || {};
    for (const id of Object.keys(imgs)) {
      try {
        const blob = dataURLToBlob(imgs[id]);
        await idbPut('images', { id, blob, createdAt: Date.now() });
      } catch (e) { /* bỏ qua ảnh lỗi */ }
    }

    state.sel = { in: null, out: null };
    state.detailId = null;
    await refresh();
    closeModal('#settingsModal');
    toast('Đã khôi phục dữ liệu');
  } catch (e) {
    console.error(e);
    toast('Khôi phục thất bại', 'error');
  }
}

async function clearAll() {
  const ok = await confirmDialog({
    title: 'Xóa toàn bộ dữ liệu?',
    message: 'Tất cả hàng hóa, ảnh và lịch sử nhập xuất sẽ bị xóa vĩnh viễn. Hãy sao lưu trước nếu cần.',
    confirmText: 'Xóa tất cả',
    danger: true,
  });
  if (!ok) return;
  try {
    await Promise.all(['products', 'transactions', 'images'].map(idbClear));
    state.sel = { in: null, out: null };
    state.detailId = null;
    await refresh();
    closeModal('#settingsModal');
    toast('Đã xóa toàn bộ dữ liệu');
  } catch (e) {
    console.error(e);
    toast('Không xóa được dữ liệu', 'error');
  }
}

async function updateStorageText() {
  const el = $('#storageText');
  if (!el) return;
  let text = `${state.products.length} mặt hàng · ${state.txs.length} giao dịch`;
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (est && typeof est.usage === 'number' && est.usage > 0) {
        const mb = est.usage / (1024 * 1024);
        text += ` · ${mb < 1 ? (est.usage / 1024).toFixed(0) + ' KB' : mb.toFixed(1) + ' MB'}`;
      }
    } catch (e) { /* bỏ qua */ }
  }
  el.textContent = text;
}

/* ---------------- ngày mặc định ---------------- */
function setDefaultDates() {
  const v = localDT(new Date());
  const a = $('#inDate');
  const b = $('#outDate');
  if (a) a.value = v;
  if (b) b.value = v;
}

/* ---------------- gắn sự kiện ---------------- */
function bindEvents() {
  // nav
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  window.addEventListener('hashchange', () => {
    const t = (location.hash || '').replace('#', '');
    if (TABS.includes(t) && t !== state.tab) switchTab(t, false);
  });

  // đóng modal
  document.addEventListener('click', e => {
    const closer = e.target.closest('[data-close]');
    if (!closer) return;
    const modal = closer.closest('.modal');
    if (!modal) return;
    if (modal.id === 'confirmModal') { settleConfirm(false); return; }
    if (modal.id === 'productModal') resetProductDraft();
    closeModal('#' + modal.id);
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#confirmModal').hidden) { settleConfirm(false); return; }
    const open = $$('.modal:not([hidden])').pop();
    if (!open) return;
    if (open.id === 'productModal') resetProductDraft();
    closeModal('#' + open.id);
  });

  // cài đặt
  $('#btnSettings').addEventListener('click', () => { updateStorageText(); showModal('#settingsModal'); });
  $('#btnExport').addEventListener('click', exportData);
  $('#btnImport').addEventListener('click', () => $('#importInput').click());
  $('#btnClear').addEventListener('click', clearAll);
  $('#importInput').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    importData(file);
  });

  // xác nhận
  $('#cfOk').addEventListener('click', () => settleConfirm(true));
  $('#cfCancel').addEventListener('click', () => settleConfirm(false));

  // thêm hàng hóa
  $('#btnAddProduct').addEventListener('click', () => { state.pickerTarget = null; openProductModal(); });
  $('#emptyAdd').addEventListener('click', () => { state.pickerTarget = null; openProductModal(); });

  // form nhập/xuất
  $('#form-in').addEventListener('submit', e => { e.preventDefault(); saveTx('in'); });
  $('#form-out').addEventListener('submit', e => { e.preventDefault(); saveTx('out'); });

  // chọn hàng hóa
  document.addEventListener('click', e => {
    const pick = e.target.closest('[data-pick]');
    if (pick) { openPicker(pick.dataset.pick); return; }
  });
  $('#pickerList').addEventListener('click', e => {
    if (e.target.closest('#pickerNewInline')) { closeModal('#pickerModal'); openProductModal(); return; }
    const row = e.target.closest('[data-pick-id]');
    if (!row || !state.pickerTarget) return;
    selectProduct(state.pickerTarget, row.dataset.pickId);
    closeModal('#pickerModal');
  });
  $('#pickerSearch').addEventListener('input', renderPickerList);
  $('#pickerNew').addEventListener('click', () => { closeModal('#pickerModal'); openProductModal(); });

  // tìm kiếm / lọc tồn kho
  $('#stockSearch').addEventListener('input', e => { state.stockSearch = e.target.value; renderStock(); });
  $('#stockChips').addEventListener('click', e => {
    const chip = e.target.closest('[data-sfilter]');
    if (!chip) return;
    state.stockFilter = chip.dataset.sfilter;
    renderStock();
  });

  // danh sách tồn kho
  $('#stockList').addEventListener('click', e => {
    const card = e.target.closest('.p-card');
    if (!card) return;
    const id = card.dataset.id;
    const btn = e.target.closest('[data-act]');
    const act = btn ? btn.dataset.act : 'open';
    if (act === 'in') startTx('in', id);
    else if (act === 'out') startTx('out', id);
    else openDetail(id);
  });

  // lịch sử
  $('#historySearch').addEventListener('input', e => { state.historySearch = e.target.value; renderHistory(); });
  $('#historyChips').addEventListener('click', e => {
    const chip = e.target.closest('[data-htype]');
    if (!chip) return;
    state.historyType = chip.dataset.htype;
    renderHistory();
  });
  $('#historyList').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { deleteTx(del.dataset.del); return; }
    const row = e.target.closest('.h-row');
    if (row) openDetail(row.dataset.pid);
  });

  // preview số lượng
  ['in', 'out'].forEach(type => {
    const qty = $(`#${type}Qty`);
    qty.addEventListener('input', () => updatePreview(type));
    qty.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); saveTx(type); }
    });
  });

  // modal hàng hóa
  $('#pmSave').addEventListener('click', saveProduct);
  $('#pmCamera').addEventListener('click', () => $('#cameraInput').click());
  $('#pmGallery').addEventListener('click', () => $('#galleryInput').click());
  $('#pmRemoveImg').addEventListener('click', clearDraftImage);
  $('#cameraInput').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    handleImageFile(f);
  });
  $('#galleryInput').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    handleImageFile(f);
  });
  $('#pmName').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveProduct(); }
  });

  // chi tiết
  $('#detailBody').addEventListener('click', e => {
    const btn = e.target.closest('[data-dact]');
    if (!btn) return;
    const act = btn.dataset.dact;
    const id = state.detailId;
    if (act === 'in' || act === 'out') {
      closeModal('#detailModal');
      startTx(act, id);
    } else if (act === 'edit') {
      state.pickerTarget = null;
      openProductModal(id);
    } else if (act === 'delete') {
      deleteProduct(id);
    } else if (act === 'all') {
      const p = productById(id);
      if (!p) return;
      state.historySearch = p.name;
      state.historyType = 'all';
      $('#historySearch').value = p.name;
      closeModal('#detailModal');
      switchTab('history');
      renderHistory();
    }
  });

  // ảnh: kéo thả trên desktop (tiện dụng)
  const preview = $('#pmPreview');
  ['dragover', 'drop'].forEach(evName => preview.addEventListener(evName, e => {
    e.preventDefault();
    if (evName === 'drop') handleImageFile(e.dataTransfer.files && e.dataTransfer.files[0]);
  }));
}

/* ---------------- service worker ---------------- */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (!location.protocol.startsWith('http')) return;
  const start = () => navigator.serviceWorker.register('sw.js').catch(() => {});
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

/* ---------------- khởi động ---------------- */
async function init() {
  setDefaultDates();
  bindEvents();

  try {
    await loadAll();
  } catch (e) {
    console.error(e);
    toast('Không mở được dữ liệu trên trình duyệt này', 'error');
  }

  renderStock();
  renderHistory();
  renderFormState('in');
  renderFormState('out');
  const initialTab = (location.hash || '').replace('#', '');
  switchTab(TABS.includes(initialTab) ? initialTab : 'stock');
  updateStorageText();
  registerSW();

  const now = new Date();
  $('#headerSub').textContent = `${WEEKDAYS[now.getDay()]}, ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
}

document.addEventListener('DOMContentLoaded', init);
