// =========================================================
// Salon — chat multijoueur temps réel, 100 % pair-à-pair
// WebRTC via Trystero (signalisation par relais Nostr publics)
// Aucun serveur, aucune base de données, aucune clé d'API.
// =========================================================

// Version ÉPINGLÉE : Trystero 0.27+ a changé d'API (plus de sous-chemin /nostr,
// plus d'export selfId, makeAction renvoie un objet). Ce code cible l'API 0.21.x.
// Alternatives gratuites de signalisation (même version) :
//   'https://cdn.jsdelivr.net/npm/trystero@0.21.8/torrent/+esm'  (trackers BitTorrent)
//   'https://cdn.jsdelivr.net/npm/trystero@0.21.8/mqtt/+esm'     (brokers MQTT publics)
const TRYSTERO_URL = 'https://cdn.jsdelivr.net/npm/trystero@0.21.8/nostr/+esm';

// ⚠️ Changez cet identifiant pour VOTRE déploiement : seuls les clients
// partageant le même APP_ID peuvent se voir.
const APP_ID = 'salon-chat-p2p-fr-7f3a91';

const MAX_NAME = 24;
const MAX_TEXT = 2000;
const MAX_IMAGES = 4;
const GROUP_WINDOW = 5 * 60 * 1000;   // regroupe les messages d'un même auteur (5 min)
const TYPING_TTL = 3500;              // expiration de "en train d'écrire" côté réception
const TYPING_RESEND = 2000;           // ré-émission pendant la frappe
const TYPING_IDLE = 3000;             // arrêt après inactivité
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I

const EMOJIS = [
  '😀','😂','🤣','😊','😍','🥰','😘','😎',
  '🤩','🥳','😇','🤔','🤨','😏','😴','🥲',
  '😢','😭','😡','🤯','😱','🙈','💀','🤝',
  '👍','👎','👏','🙌','🙏','💪','👋','✌️',
  '❤️','🧡','💛','💚','💙','💜','🔥','✨',
  '🎉','🎁','☕','🍕','🚀','💯','✅','👀',
];

// Chargement non bloquant de Trystero : l'interface reste utilisable même si le CDN tarde.
const trysteroReady = import(TRYSTERO_URL);

// ---------------------------------------------------------
// DOM
// ---------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const ui = {
  lobby: $('#lobby'),
  chat: $('#chat'),
  joinForm: $('#join-form'),
  joinBtn: $('#join-btn'),
  nameInput: $('#name-input'),
  codeInput: $('#code-input'),
  randomBtn: $('#random-btn'),
  inviteNote: $('#invite-note'),
  lobbyError: $('#lobby-error'),
  userList: $('#user-list'),
  status: $('#conn-status'),
  statusDot: $('#status-dot'),
  messages: $('#messages'),
  jumpBtn: $('#jump-btn'),
  typing: $('#typing'),
  typingText: $('#typing-text'),
  composer: $('#composer'),
  textInput: $('#text-input'),
  emojiBtn: $('#emoji-btn'),
  emojiPanel: $('#emoji-panel'),
  soundBtn: $('#sound-btn'),
  leaveBtn: $('#leave-btn'),
  menuBtn: $('#menu-btn'),
  onlinePill: $('#online-pill'),
  backdrop: $('#backdrop'),
  toast: $('#toast'),
  promoBar: $('#ecosystem-promo-bar'),
  promoClose: $('#promo-close'),
};

const BASE_TITLE = document.title;

const state = {
  selfId: null,
  name: '',
  code: '',
  room: null,
  actions: null,
  peers: new Map(),   // peerId -> { name }
  typing: new Map(),  // peerId -> timeoutId
  last: null,         // { sender, ts } pour le regroupement
  unread: 0,
  stickToBottom: true,
  typingSentAt: 0,
  typingIdleTimer: null,
  sound: true,
  joining: false,
};

// ---------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------
const storage = {
  get(key, session = false) {
    try { return (session ? sessionStorage : localStorage).getItem(key); } catch { return null; }
  },
  set(key, value, session = false) {
    try { (session ? sessionStorage : localStorage).setItem(key, value); } catch { /* mode privé */ }
  },
};

/** Crée un élément. Le texte passe TOUJOURS par textContent (anti-XSS). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Retire caractères de contrôle et caractères de contrôle bidirectionnels (usurpation visuelle). */
function cleanName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .slice(0, MAX_TEXT)
    .trim();
}

function cleanCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function randomCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

function initials(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[0]);
  const second = parts[1] ? Array.from(parts[1])[0] : (first[1] ?? '');
  return (first[0] + second).toUpperCase();
}

function hueFor(name) {
  let h = 2166136261;
  for (const ch of name.toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return Math.abs(h) % 360;
}

function avatar(name) {
  const node = el('span', 'avatar', initials(name));
  node.style.setProperty('--h', String(hueFor(name)));
  node.setAttribute('aria-hidden', 'true');
  return node;
}

const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

let toastTimer;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2400);
}

function readHashCode() {
  const params = new URLSearchParams(location.hash.slice(1));
  return cleanCode(params.get('room'));
}

function inviteUrl() {
  return `${location.origin}${location.pathname}#room=${state.code}`;
}

// ---------------------------------------------------------
// Rendu sécurisé du texte (liens + images), sans innerHTML
// ---------------------------------------------------------
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCT = /[.,!?;:)\]}'"»]+$/;
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|⃣|\s)+$/u;
const PICTO = /\p{Extended_Pictographic}/gu;

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Découpe le message en nœuds texte / liens et extrait les URLs d'images.
 * Retourne { fragment, hasText, images }.
 */
function renderRich(text) {
  const fragment = document.createDocumentFragment();
  const images = [];
  let plain = '';
  let cursor = 0;

  for (const match of text.matchAll(URL_RE)) {
    let raw = match[0];
    const trail = raw.match(TRAILING_PUNCT);
    if (trail) raw = raw.slice(0, -trail[0].length);

    const before = text.slice(cursor, match.index);
    fragment.append(before);            // append(string) => nœud Text, jamais du HTML
    plain += before;
    cursor = match.index + raw.length;

    const url = safeUrl(raw);
    if (!url) { fragment.append(raw); plain += raw; continue; }

    if (url.protocol === 'https:' && IMG_EXT.test(url.pathname) && images.length < MAX_IMAGES) {
      images.push(url.href);            // affichée sous le texte
      continue;
    }
    const a = el('a', null, raw);
    a.href = url.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow ugc';
    fragment.append(a);
    plain += raw;
  }
  const rest = text.slice(cursor);
  fragment.append(rest);
  plain += rest;

  return { fragment, hasText: plain.trim().length > 0, images };
}

function imageNode(href) {
  const link = el('a', 'media');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer nofollow ugc';

  const img = el('img');
  img.alt = 'Image partagée';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('load', () => { if (state.stickToBottom) scrollToBottom(); });
  img.addEventListener('error', () => {
    link.replaceChildren(el('span', 'media-broken', '🖼️ Image indisponible — ouvrir le lien'));
  });
  img.src = href;

  link.append(img);
  return link;
}

function isJumbo(text) {
  if (!EMOJI_ONLY.test(text)) return false;
  const count = (text.match(PICTO) || []).length;
  return count >= 1 && count <= 3;
}

// ---------------------------------------------------------
// Messages
// ---------------------------------------------------------
function isNearBottom() {
  const m = ui.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}

function scrollToBottom() {
  ui.messages.scrollTop = ui.messages.scrollHeight;
  ui.jumpBtn.hidden = true;
}

function addMessage({ sender, name, text, ts, self }) {
  const wasAtBottom = isNearBottom();
  const grouped = state.last && state.last.sender === sender && ts - state.last.ts < GROUP_WINDOW;

  const row = el('div', `msg${self ? ' self' : ''}${grouped ? ' grouped' : ''}`);
  const col = el('div', 'msg-col');
  const time = timeFmt.format(ts);

  if (!grouped) {
    const meta = el('div', 'msg-meta');
    const nameNode = el('span', 'msg-name', self ? 'Vous' : name);
    if (!self) nameNode.style.color = `hsl(${hueFor(name)} 80% 72%)`;
    const timeNode = el('time', 'msg-time', time);
    timeNode.dateTime = new Date(ts).toISOString();
    meta.append(nameNode, timeNode);
    col.append(meta);
  }

  const { fragment, hasText, images } = renderRich(text);
  if (hasText) {
    const bubble = el('div', `bubble${isJumbo(text) ? ' jumbo' : ''}`);
    bubble.title = time;
    bubble.append(fragment);
    col.append(bubble);
  }
  for (const src of images) col.append(imageNode(src));

  row.append(grouped ? el('span', 'avatar-spacer') : avatar(name), col);
  ui.messages.append(row);
  state.last = { sender, ts };

  if (self || wasAtBottom) scrollToBottom();
  else ui.jumpBtn.hidden = false;
}

function addSystem(text) {
  const wasAtBottom = isNearBottom();
  const row = el('div', 'sys');
  row.append(el('span', null, text));
  ui.messages.append(row);
  state.last = null;
  if (wasAtBottom) scrollToBottom();
}

function addInviteCard() {
  const card = el('div', 'invite-card');
  card.append(
    el('h3', null, 'Votre salon est prêt ✨'),
    el('p', null, 'Partagez ce code ou le lien d’invitation. Vos amis rejoindront automatiquement en cliquant dessus.'),
    el('strong', 'invite-code', state.code),
  );
  const btn = el('button', 'btn btn-primary btn-sm', '🔗 Copier le lien d’invitation');
  btn.type = 'button';
  btn.dataset.copyLink = '';
  card.append(btn);
  ui.messages.append(card);
}

// ---------------------------------------------------------
// Participants
// ---------------------------------------------------------
function renderUsers() {
  const count = state.peers.size + 1;
  $$('[data-online-count]').forEach((n) => { n.textContent = String(count); });

  const alone = state.peers.size === 0;
  ui.status.textContent = alone
    ? 'En attente d’autres participants…'
    : `${count} participant${count > 1 ? 's' : ''} connecté${count > 1 ? 's' : ''}`;
  ui.statusDot.classList.toggle('live', !alone);
  ui.statusDot.classList.toggle('pulse', alone);

  const others = [...state.peers]
    .map(([id, p]) => ({ id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  const users = [{ id: state.selfId, name: state.name, self: true }, ...others];

  ui.userList.replaceChildren(...users.map((u) => {
    const li = el('li', 'user');
    const wrap = el('span', 'avatar-wrap');
    wrap.append(avatar(u.name));
    li.append(wrap, el('span', 'user-name', u.name));
    if (u.self) li.append(el('span', 'user-tag', 'vous'));
    else if (state.typing.has(u.id)) li.append(el('span', 'user-typing', 'écrit…'));
    return li;
  }));
}

// ---------------------------------------------------------
// "… est en train d'écrire"
// ---------------------------------------------------------
function setPeerTyping(id) {
  const fresh = !state.typing.has(id);
  clearTimeout(state.typing.get(id));
  state.typing.set(id, setTimeout(() => clearPeerTyping(id), TYPING_TTL));
  if (fresh) { renderTyping(); renderUsers(); }
}

function clearPeerTyping(id) {
  if (!state.typing.has(id)) return;
  clearTimeout(state.typing.get(id));
  state.typing.delete(id);
  renderTyping();
  renderUsers();
}

function renderTyping() {
  const names = [...state.typing.keys()].map((id) => state.peers.get(id)?.name).filter(Boolean);
  let text = '';
  if (names.length === 1) text = `${names[0]} est en train d’écrire…`;
  else if (names.length === 2) text = `${names[0]} et ${names[1]} sont en train d’écrire…`;
  else if (names.length > 2) text = 'Plusieurs personnes sont en train d’écrire…';
  ui.typingText.textContent = text;
  ui.typing.classList.toggle('show', Boolean(text));
}

function onLocalTyping() {
  if (!state.actions) return;
  if (!ui.textInput.value.trim()) { stopLocalTyping(); return; }
  const now = Date.now();
  if (now - state.typingSentAt > TYPING_RESEND) {
    state.actions.sendTyping({ t: 1 });
    state.typingSentAt = now;
  }
  clearTimeout(state.typingIdleTimer);
  state.typingIdleTimer = setTimeout(stopLocalTyping, TYPING_IDLE);
}

function stopLocalTyping() {
  clearTimeout(state.typingIdleTimer);
  if (state.typingSentAt && state.actions) state.actions.sendTyping({ t: 0 });
  state.typingSentAt = 0;
}

// ---------------------------------------------------------
// Notifications (Web Audio, aucun fichier externe)
// ---------------------------------------------------------
let audioCtx = null;

function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx ??= new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

function playPing() {
  if (!state.sound || !audioCtx) return;
  const t = audioCtx.currentTime;
  // Deux notes douces (La5 → Mi6)
  [[880, 0], [1318.5, 0.09]].forEach(([freq, delay]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(0.07, t + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.28);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 0.3);
  });
}

function tabIsActive() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function notifyIncoming() {
  if (tabIsActive()) return;
  state.unread += 1;
  document.title = `(${state.unread}) ${BASE_TITLE}`;
  playPing();
}

function clearUnread() {
  if (!tabIsActive()) return;
  state.unread = 0;
  document.title = state.code ? `#${state.code} · ${BASE_TITLE}` : BASE_TITLE;
}

function setSound(on) {
  state.sound = on;
  ui.soundBtn.textContent = on ? '🔔' : '🔕';
  ui.soundBtn.setAttribute('aria-pressed', String(on));
  ui.soundBtn.title = on ? 'Son activé' : 'Son coupé';
  storage.set('salon:sound', on ? '1' : '0');
}

// ---------------------------------------------------------
// Salon (Trystero)
// ---------------------------------------------------------
async function enterRoom(name, code) {
  if (state.joining) return;
  state.joining = true;
  ui.joinBtn.disabled = ui.randomBtn.disabled = true;
  ui.joinBtn.textContent = 'Connexion…';

  let trystero;
  try {
    trystero = await trysteroReady;
  } catch (err) {
    console.error(err);
    showLobbyError('Impossible de charger le module P2P. Vérifiez votre connexion ou désactivez le bloqueur de contenu.');
    resetJoinButtons();
    return;
  }

  state.selfId = trystero.selfId;
  state.name = name;
  state.code = code;
  state.peers.clear();
  state.last = null;
  storage.set('salon:name', name);
  history.replaceState(null, '', `#room=${code}`);

  $$('[data-room-code]').forEach((n) => { n.textContent = code; });
  ui.messages.replaceChildren();
  showScreen('chat');
  clearUnread();

  addSystem(`Vous avez rejoint #${code} en tant que « ${name} »`);
  addInviteCard();

  let room;
  try {
    room = trystero.joinRoom({ appId: APP_ID }, code);
  } catch (err) {
    console.error(err);
    toast('Connexion au salon impossible 😕');
    leaveRoom();
    return;
  }
  state.room = room;

  // Les noms d'actions Trystero sont limités à 12 octets.
  const [sendHello, onHello] = room.makeAction('hello');
  const [sendChat, onChat] = room.makeAction('chat');
  const [sendTyping, onTyping] = room.makeAction('typing');
  state.actions = { sendHello, sendChat, sendTyping };

  room.onPeerJoin((peerId) => {
    sendHello({ name: state.name }, peerId);
  });

  room.onPeerLeave((peerId) => {
    const peer = state.peers.get(peerId);
    state.peers.delete(peerId);
    clearPeerTyping(peerId);
    if (peer) addSystem(`${peer.name} a quitté le salon`);
    renderUsers();
  });

  onHello((data, peerId) => {
    const peerName = cleanName(data?.name) || 'Anonyme';
    const known = state.peers.has(peerId);
    state.peers.set(peerId, { name: peerName });
    if (!known) {
      addSystem(`${peerName} a rejoint le salon 👋`);
      notifyIncoming();
    }
    renderUsers();
  });

  onChat((data, peerId) => {
    if (!data || typeof data.text !== 'string') return;
    const text = cleanText(data.text);
    if (!text) return;
    let peer = state.peers.get(peerId);
    if (!peer) {
      peer = { name: cleanName(data.name) || 'Anonyme' };
      state.peers.set(peerId, peer);
      renderUsers();
    }
    clearPeerTyping(peerId);
    // Horodatage local à la réception : impossible à falsifier par l'expéditeur.
    addMessage({ sender: peerId, name: peer.name, text, ts: Date.now(), self: false });
    notifyIncoming();
  });

  onTyping((data, peerId) => {
    if (!state.peers.has(peerId)) return;
    if (data?.t) setPeerTyping(peerId);
    else clearPeerTyping(peerId);
  });

  renderUsers();
  renderTyping();
  resetJoinButtons();
  if (matchMedia('(pointer: fine)').matches) ui.textInput.focus();
}

function leaveRoom() {
  stopLocalTyping();
  try { state.room?.leave(); } catch { /* déjà fermé */ }
  state.room = null;
  state.actions = null;
  state.peers.clear();
  state.typing.forEach(clearTimeout);
  state.typing.clear();
  state.code = '';
  renderTyping();
  closeEmojiPanel();
  ui.chat.classList.remove('sidebar-open');
  ui.textInput.value = '';
  autosize();
  history.replaceState(null, '', location.pathname + location.search);
  document.title = BASE_TITLE;
  ui.codeInput.value = '';
  ui.inviteNote.hidden = true;
  resetJoinButtons();
  showScreen('lobby');
}

function sendMessage() {
  const text = cleanText(ui.textInput.value);
  if (!text || !state.actions) return;
  state.actions.sendChat({ text, name: state.name });
  addMessage({ sender: state.selfId, name: state.name, text, ts: Date.now(), self: true });
  ui.textInput.value = '';
  autosize();
  stopLocalTyping();
  closeEmojiPanel();
  ui.textInput.focus();
}

// ---------------------------------------------------------
// Écrans & lobby
// ---------------------------------------------------------
function showScreen(name) {
  ui.lobby.hidden = name !== 'lobby';
  ui.chat.hidden = name !== 'chat';
}

function showLobbyError(message) {
  ui.lobbyError.textContent = message;
}

function resetJoinButtons() {
  state.joining = false;
  ui.joinBtn.disabled = ui.randomBtn.disabled = false;
  ui.joinBtn.textContent = 'Rejoindre le salon';
}

function validateName() {
  const name = cleanName(ui.nameInput.value);
  if (name.length < 2) {
    showLobbyError('Choisissez un pseudo d’au moins 2 caractères.');
    ui.nameInput.focus();
    return null;
  }
  return name;
}

function handleJoin(event) {
  event.preventDefault();
  showLobbyError('');
  const name = validateName();
  if (!name) return;
  const code = cleanCode(ui.codeInput.value);
  if (code.length < 3) {
    showLobbyError('Entrez un code de salon (3 caractères minimum) ou créez-en un aléatoire.');
    ui.codeInput.focus();
    return;
  }
  enterRoom(name, code);
}

function handleRandom() {
  showLobbyError('');
  const code = randomCode();
  ui.codeInput.value = code;
  const name = validateName();
  if (name) enterRoom(name, code);
}

// ---------------------------------------------------------
// Copier le lien d'invitation
// ---------------------------------------------------------
async function copyInvite() {
  if (!state.code) return;
  const url = inviteUrl();
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    const ta = el('textarea');
    ta.value = url;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  toast(ok ? 'Lien d’invitation copié ✓' : `Copiez ce lien : ${url}`);
}

// ---------------------------------------------------------
// Composer : auto-hauteur, emojis, raccourcis
// ---------------------------------------------------------
function autosize() {
  const t = ui.textInput;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

function buildEmojiPanel() {
  ui.emojiPanel.replaceChildren(...EMOJIS.map((emoji) => {
    const b = el('button', null, emoji);
    b.type = 'button';
    b.setAttribute('aria-label', emoji);
    return b;
  }));
}

function toggleEmojiPanel() {
  const open = ui.emojiPanel.hidden;
  ui.emojiPanel.hidden = !open;
  ui.emojiBtn.setAttribute('aria-expanded', String(open));
}

function closeEmojiPanel() {
  ui.emojiPanel.hidden = true;
  ui.emojiBtn.setAttribute('aria-expanded', 'false');
}

function insertAtCursor(text) {
  const t = ui.textInput;
  const start = t.selectionStart ?? t.value.length;
  const end = t.selectionEnd ?? t.value.length;
  t.setRangeText(text, start, end, 'end');
  t.focus();
  autosize();
  onLocalTyping();
}

// ---------------------------------------------------------
// Événements
// ---------------------------------------------------------
function bindEvents() {
  ui.joinForm.addEventListener('submit', handleJoin);
  ui.randomBtn.addEventListener('click', handleRandom);
  ui.codeInput.addEventListener('input', () => {
    const pos = ui.codeInput.selectionStart;
    ui.codeInput.value = cleanCode(ui.codeInput.value);
    ui.codeInput.setSelectionRange(pos, pos);
  });

  // Délégation : tous les boutons "Copier le lien d'invitation"
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-copy-link]')) copyInvite();
    if (!ui.emojiPanel.hidden && !e.target.closest('#emoji-panel, #emoji-btn')) closeEmojiPanel();
  });

  ui.composer.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
  ui.textInput.addEventListener('input', () => { autosize(); onLocalTyping(); });
  ui.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'Escape') {
      closeEmojiPanel();
    }
  });

  ui.emojiBtn.addEventListener('click', toggleEmojiPanel);
  ui.emojiPanel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) insertAtCursor(b.textContent);
  });

  ui.messages.addEventListener('scroll', () => {
    state.stickToBottom = isNearBottom();
    if (state.stickToBottom) ui.jumpBtn.hidden = true;
  }, { passive: true });
  ui.jumpBtn.addEventListener('click', scrollToBottom);

  ui.soundBtn.addEventListener('click', () => { unlockAudio(); setSound(!state.sound); });
  ui.leaveBtn.addEventListener('click', leaveRoom);

  const openSidebar = () => ui.chat.classList.add('sidebar-open');
  const closeSidebar = () => ui.chat.classList.remove('sidebar-open');
  ui.menuBtn.addEventListener('click', openSidebar);
  ui.onlinePill.addEventListener('click', () => {
    if (matchMedia('(max-width: 860px)').matches) openSidebar();
  });
  ui.backdrop.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

  // L'audio ne peut démarrer qu'après une interaction utilisateur
  ['pointerdown', 'keydown'].forEach((type) =>
    document.addEventListener(type, unlockAudio, { passive: true }));

  document.addEventListener('visibilitychange', clearUnread);
  window.addEventListener('focus', clearUnread);

  window.addEventListener('hashchange', () => {
    const code = readHashCode();
    if (!code) return;
    if (state.room && code !== state.code) {
      const name = state.name;
      leaveRoom();
      enterRoom(name, code);
    } else if (!state.room) {
      ui.codeInput.value = code;
    }
  });

  window.addEventListener('pagehide', () => { try { state.room?.leave(); } catch { /* */ } });

  ui.promoClose.addEventListener('click', () => {
    ui.promoBar.hidden = true;
    storage.set('salon:promo-hidden', '1', true);
  });
}

// ---------------------------------------------------------
// Démarrage
// ---------------------------------------------------------
function init() {
  buildEmojiPanel();
  bindEvents();
  setSound(storage.get('salon:sound') !== '0');
  if (storage.get('salon:promo-hidden', true) === '1') ui.promoBar.hidden = true;

  const savedName = cleanName(storage.get('salon:name'));
  if (savedName) ui.nameInput.value = savedName;

  const hashCode = readHashCode();
  if (hashCode) {
    ui.codeInput.value = hashCode;
    ui.inviteNote.textContent = `Vous êtes invité·e dans le salon ${hashCode} 🎉`;
    ui.inviteNote.hidden = false;
    // Lien d'invitation + pseudo déjà connu => on rejoint directement
    if (savedName.length >= 2) { enterRoom(savedName, hashCode); return; }
    ui.nameInput.focus();
  } else {
    (savedName ? ui.codeInput : ui.nameInput).focus();
  }
}

init();
