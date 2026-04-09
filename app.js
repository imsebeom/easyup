import { initializeApp } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js";
import { getFirestore, collection, doc, setDoc, getDoc, getDocs, deleteDoc, updateDoc, onSnapshot, query, orderBy, serverTimestamp, where, getCountFromServer } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";
import { getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-storage.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);

// ══════════════════════════════════════
//  CONSTANTS & UTILITIES (extracted)
// ══════════════════════════════════════
const TYPE_CONFIG = {
  url:  { icon: '🔗', label: '🔗 URL',    cls: 'type-url' },
  text: { icon: '📝', label: '📝 텍스트', cls: 'type-text' },
  file: { icon: '📎', label: '📎 파일',   cls: 'type-file' }
};

const INQUIRY_CATEGORIES = {
  factual:    { icon: '🔍', label: '사실적 질문', color: '#dbeafe' },
  conceptual: { icon: '💡', label: '개념적 질문', color: '#dcfce7' },
  debatable:  { icon: '⚖️', label: '논쟁적 질문', color: '#fef3c7' },
  featured:   { icon: '⭐', label: '이번 주 탐구 질문', color: '#e8d5e8' },
  resolved:   { icon: '✅', label: '해결된 질문', color: '#f1f5f9' },
};

// Student-selectable categories (excluding teacher-only ones)
const STUDENT_CATEGORIES = ['factual', 'conceptual', 'debatable'];

const CL_GROUP_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'];

// ── Touch Drag Utility ──
// Unified touch drag system for both inquiry shelf and assignment list
function setupTouchDrag(container, {
  cardSelector,
  canDrag,           // optional: (card) => boolean
  getDropTarget,     // (touchX, touchY, ghost) => { category?, afterEl?, cardsContainer? }
  onDrop,            // (cardId, dropInfo) => Promise
  highlightDrop,     // (dropInfo) => void
  clearHighlight,    // () => void
}) {
  let touchDragId = null;
  let touchDragEl = null;
  let ghost = null;
  let touchStartY = 0;
  let touchStartX = 0;
  let longPressTimer = null;
  let isDragging = false;

  container.addEventListener('touchstart', (e) => {
    const card = e.target.closest(cardSelector);
    if (!card || !card.getAttribute('draggable')) return;
    if (canDrag && !canDrag(card)) return;
    // Don't start drag from buttons
    if (e.target.closest('button')) return;

    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchDragId = card.dataset.id;
    touchDragEl = card;

    longPressTimer = setTimeout(() => {
      isDragging = true;
      card.classList.add('dragging');
      // Create ghost
      ghost = card.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.position = 'fixed';
      ghost.style.width = card.offsetWidth + 'px';
      ghost.style.zIndex = '9999';
      ghost.style.pointerEvents = 'none';
      ghost.style.opacity = '0.85';
      ghost.style.transform = 'rotate(2deg) scale(1.03)';
      ghost.style.boxShadow = '0 8px 25px rgba(0,0,0,0.2)';
      ghost.style.left = (touchStartX - card.offsetWidth / 2) + 'px';
      ghost.style.top = (touchStartY - 20) + 'px';
      document.body.appendChild(ghost);
      // Haptic feedback if available
      if (navigator.vibrate) navigator.vibrate(30);
    }, 300);
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!isDragging || !ghost) {
      // Cancel long press if moved too much before activation
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        clearTimeout(longPressTimer);
      }
      return;
    }
    e.preventDefault();
    const tx = e.touches[0].clientX;
    const ty = e.touches[0].clientY;
    ghost.style.left = (tx - ghost.offsetWidth / 2) + 'px';
    ghost.style.top = (ty - 20) + 'px';

    const dropInfo = getDropTarget(tx, ty, ghost);
    clearHighlight();
    if (dropInfo) highlightDrop(dropInfo);
  }, { passive: false });

  container.addEventListener('touchend', async (e) => {
    clearTimeout(longPressTimer);
    if (!isDragging || !touchDragId) {
      isDragging = false;
      touchDragId = null;
      touchDragEl = null;
      return;
    }
    // Get last touch position
    const tx = e.changedTouches[0].clientX;
    const ty = e.changedTouches[0].clientY;

    if (touchDragEl) touchDragEl.classList.remove('dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    clearHighlight();

    const dropInfo = getDropTarget(tx, ty, null);
    if (dropInfo) {
      await onDrop(touchDragId, dropInfo, ty);
    }
    isDragging = false;
    touchDragId = null;
    touchDragEl = null;
  });

  container.addEventListener('touchcancel', () => {
    clearTimeout(longPressTimer);
    if (touchDragEl) touchDragEl.classList.remove('dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    clearHighlight();
    isDragging = false;
    touchDragId = null;
    touchDragEl = null;
  });
}

// Track sort orders for assignment board
let assignmentSortOrders = {};

// Cached DateTimeFormat instances
const dtfFull  = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dtfShort = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' });

function formatDate(d)      { return dtfFull.format(d); }
function formatDateShort(d)  { return dtfShort.format(d); }

function formatSize(b) {
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'KB';
  return (b / (1024 * 1024)).toFixed(1) + 'MB';
}

function escapeHtml(s) {
  const el = document.createElement('div');
  el.textContent = s;
  return el.innerHTML;
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

/** Custom confirm modal (replaces browser confirm) */
function showConfirm(message, okLabel = '삭제') {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-message').textContent = message;
    const okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = okLabel;
    modal.style.display = 'flex';

    function cleanup(result) {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      document.getElementById('confirm-cancel').removeEventListener('click', onCancel);
      modal.querySelector('.modal-overlay').removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener('click', onOk);
    document.getElementById('confirm-cancel').addEventListener('click', onCancel);
    modal.querySelector('.modal-overlay').addEventListener('click', onCancel);
  });
}

/** Set text and show/hide element */
function setTextVisibility(elementId, text) {
  const el = document.getElementById(elementId);
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}

/** Check if the current board is closed (by status, deadline, or private) */
function isBoardClosed() {
  if (!currentBoard) return false;
  if (currentBoard.status === 'closed' || currentBoard.status === 'private') return true;
  if (currentBoard.deadline && new Date() > new Date(currentBoard.deadline)) return true;
  return false;
}

/** Check if the current board is private (students cannot even view) */
function isBoardPrivate() {
  return currentBoard?.status === 'private';
}

/** Render deadline notice into an element */
function renderDeadline(elementId, deadline) {
  const el = document.getElementById(elementId);
  if (!deadline) { el.style.display = 'none'; return; }
  const dl = new Date(deadline);
  const expired = new Date() > dl;
  el.textContent = expired
    ? `⚠️ 마감 기한이 지났습니다 (${formatDate(dl)})`
    : `⏰ 마감: ${formatDate(dl)}`;
  el.className = expired ? 'deadline-notice expired' : 'deadline-notice';
  el.style.display = 'block';
}

/** Delete files from Storage in parallel */
async function deleteStorageFiles(files) {
  if (!files?.length) return;
  await Promise.all(files.map(f => deleteObject(ref(storage, f.path)).catch(() => {})));
}

/** Media type detection by file extension */
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'ogg'];
function getMediaType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return null;
}

/** Render file links/embeds HTML (detail modal) */
function renderFileLinksHtml(files) {
  if (!files?.length) return '';
  return '<div class="submission-files">' +
    files.map(f => {
      const media = getMediaType(f.name);
      if (media === 'image') {
        return `<div class="file-media"><img class="file-embed-img" src="${escapeHtml(f.url)}" alt="${escapeHtml(f.name)}" loading="lazy"><div class="file-media-name">${escapeHtml(f.name)} (${formatSize(f.size)})</div></div>`;
      }
      if (media === 'video') {
        return `<div class="file-media"><video class="file-embed-video" src="${escapeHtml(f.url)}" controls preload="metadata"></video><div class="file-media-name">${escapeHtml(f.name)} (${formatSize(f.size)})</div></div>`;
      }
      return `<a class="file-link" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">📄 ${escapeHtml(f.name)} (${formatSize(f.size)})</a>`;
    }).join('') +
    '</div>';
}

/** Render file thumbnail for gallery cards */
function renderFileThumbnailHtml(files) {
  if (!files?.length) return '';
  let firstMedia = null, mediaType = null;
  for (const f of files) {
    const t = getMediaType(f.name);
    if (t) { firstMedia = f; mediaType = t; break; }
  }
  let thumb = '';
  if (firstMedia && mediaType === 'image') {
    thumb = `<div class="card-thumbnail"><img src="${escapeHtml(firstMedia.url)}" alt="" loading="lazy"></div>`;
  } else if (firstMedia && mediaType === 'video') {
    thumb = `<div class="card-thumbnail"><video src="${escapeHtml(firstMedia.url)}" preload="metadata" muted></video><div class="card-thumbnail-badge">▶ 영상</div></div>`;
  }
  const otherCount = files.length - (thumb ? 1 : 0);
  if (thumb) {
    return thumb + (otherCount > 0 ? `<div class="card-files"><span class="card-file-more">+${otherCount}개 파일</span></div>` : '');
  }
  return '<div class="card-files">' +
    files.slice(0, 3).map(f => `<span class="card-file-chip">📄 ${escapeHtml(truncate(f.name, 20))}</span>`).join('') +
    (files.length > 3 ? `<span class="card-file-more">+${files.length - 3}개</span>` : '') +
    '</div>';
}

/** Sanitize URL - block javascript: protocol */
function sanitizeUrl(url) {
  if (!url) return '';
  const trimmed = url.trim();
  if (/^javascript:/i.test(trimmed)) return '';
  if (!trimmed.startsWith('http')) return 'https://' + trimmed;
  return trimmed;
}

/** Build student join link for a board code */
function getJoinLink(code) {
  const origin = location.origin;
  return `${origin}${location.pathname}#join/${code}`;
}

/** Build read-only book link for a classify workspace */
function getBookLink(code, workspaceId) {
  return `${location.origin}${location.pathname}#book/${code}/${workspaceId}`;
}

/** Generate QR code as data URL (synchronous, uses QRCode.js) */
function clGenerateQrDataUrl(text, size = 100) {
  const tmp = document.createElement('div');
  tmp.style.cssText = 'position:absolute;left:-9999px;top:-9999px';
  document.body.appendChild(tmp);
  try {
    new QRCode(tmp, { text, width: size, height: size, colorDark: '#1e293b', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    const canvas = tmp.querySelector('canvas');
    return canvas ? canvas.toDataURL('image/png') : '';
  } finally {
    document.body.removeChild(tmp);
  }
}

/** Build submissions query for a board */
function submissionsQuery(boardCode) {
  return query(collection(db, 'boards', boardCode, 'submissions'), orderBy('createdAt', 'desc'));
}

// ── State ──
let currentUserRole = null; // 'admin' | 'approved' | 'pending' | 'rejected'
let currentUser = null;
let currentBoard = null;
let currentBoardCode = null;
let selectedFiles = [];
let unsubscribe = null;
let unsubscribeGallery = null;
let allBoards = [];
let currentSort = 'createdAt';
let currentSortDir = 'desc';
let showingHidden = false;
let editingSubmissionId = null;
let existingFiles = null;
let studentName = '';
let teacherEditMode = false; // true when teacher edits from board-view
let selectedBoardType = 'assignment'; // 'assignment' | 'inquiry'
let unsubscribeInquiryGallery = null;
let unsubscribeInquiryBoard = null;
let unsubscribeClassifyGallery = null;
let unsubscribeClassifyBoard = null;
let galleryDocs = [];
let currentDetailIndex = -1;
let unsubscribeComments = null;
let unsubscribeBoardDoc = null; // board doc listener for allowPeek sync

// ── Device ID ──
function getDeviceId() {
  let id = localStorage.getItem('easyup_device_id');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('easyup_device_id', id);
  }
  return id;
}
const deviceId = getDeviceId();

// ── View Management ──
window.showView = function(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
  if (unsubscribe && viewId !== 'board-view' && viewId !== 'inquiry-board-view') { unsubscribe(); unsubscribe = null; }
  if (unsubscribeGallery && viewId !== 'gallery-view') { unsubscribeGallery(); unsubscribeGallery = null; }
  if (unsubscribeInquiryGallery && viewId !== 'inquiry-gallery-view') { unsubscribeInquiryGallery(); unsubscribeInquiryGallery = null; }
  if (unsubscribeInquiryBoard && viewId !== 'inquiry-board-view') { unsubscribeInquiryBoard(); unsubscribeInquiryBoard = null; }
  if (unsubscribeClassifyGallery && viewId !== 'classify-gallery-view') { unsubscribeClassifyGallery(); unsubscribeClassifyGallery = null; }
  if (unsubscribeClassifyBoard && viewId !== 'classify-board-view') { unsubscribeClassifyBoard(); unsubscribeClassifyBoard = null; }
  if (unsubscribeBoardDoc && viewId !== 'gallery-view' && viewId !== 'inquiry-gallery-view') { unsubscribeBoardDoc(); unsubscribeBoardDoc = null; }
  if (viewId === 'users-view') loadUsers();
};

// ══════════════════════════════════════
//  AUTH & USER APPROVAL
// ══════════════════════════════════════
window.googleLogin = async function() {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { if (e.code !== 'auth/popup-closed-by-user') toast('로그인 실패'); }
};

window.googleLogout = async function() {
  await signOut(auth);
  currentUserRole = null;
  showView('login-view');
};

const ADMIN_EMAIL = firebaseConfig.adminEmail || '';

/** Check/create user doc and return role */
async function checkUserApproval(user) {
  const userRef = doc(db, 'users', user.uid);
  const userDoc = await getDoc(userRef);

  if (userDoc.exists()) {
    return userDoc.data().role;
  }

  // New user: admin email gets admin role, others get pending
  const role = user.email === ADMIN_EMAIL ? 'admin' : 'pending';

  await setDoc(userRef, {
    email: user.email,
    displayName: user.displayName || '',
    photoURL: user.photoURL || '',
    role,
    createdAt: serverTimestamp()
  });

  return role;
}

// Student routes: handle immediately before auth (no flash of login screen)
(function earlyStudentRoute() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('book/')) {
    const parts = hash.split('/');
    showReadOnlyBook(parts[1].toUpperCase(), parts[2] || '');
    return;
  }
  if (hash.startsWith('join/') || hash.startsWith('gallery/') || hash.startsWith('inquiry/') || hash.startsWith('classify/')) {
    handleStudentRoute(hash.split('/')[1].toUpperCase());
  }
})();

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  const hash = location.hash.slice(1);

  // Student/public routes: already handled by earlyStudentRoute or popstate
  if (hash.startsWith('book/') || hash.startsWith('join/') || hash.startsWith('gallery/') || hash.startsWith('inquiry/') || hash.startsWith('classify/')) {
    return;
  }

  if (!user) {
    showView('login-view');
    return;
  }

  // Check approval status
  try {
    currentUserRole = await checkUserApproval(user);
  } catch (e) {
    console.error(e);
    toast('사용자 정보 확인 실패');
    return;
  }

  document.getElementById('user-name').textContent = user.displayName || user.email;

  if (currentUserRole === 'pending' || currentUserRole === 'rejected') {
    const isRejected = currentUserRole === 'rejected';
    document.getElementById('pending-email').textContent = user.email;
    document.getElementById('pending-icon').textContent = isRejected ? '🚫' : '⏳';
    document.getElementById('pending-heading').textContent = isRejected ? '승인 거부됨' : '승인 대기 중';
    document.getElementById('pending-desc').textContent = isRejected
      ? '관리자에 의해 접근이 거부되었습니다.'
      : '관리자가 승인하면 사용할 수 있습니다.';
    showView('pending-view');
    return;
  }

  // admin or approved
  if (currentUserRole === 'admin') {
    document.getElementById('btn-manage-users').style.display = '';
  }

  // Delegate to shared router
  const routed = handleRoute();
  if (!routed) {
    showView('dashboard-view');
    location.hash = 'dashboard';
    loadMyBoards();
  }
});

// ══════════════════════════════════════
//  ADMIN: USER MANAGEMENT
// ══════════════════════════════════════
const ROLE_LABEL = { admin: '관리자', approved: '승인됨', pending: '대기중', rejected: '거부됨' };
const ROLE_CLS   = { admin: 'status-admin', approved: 'status-approved', pending: 'status-pending', rejected: 'status-rejected' };

async function loadUsers() {
  const container = document.getElementById('users-list');
  container.innerHTML = '<div class="empty-state">로딩 중...</div>';
  try {
    const snapshot = await getDocs(collection(db, 'users'));
    const users = snapshot.docs.map(d => ({ uid: d.id, ...d.data() }));

    // Load all boards for usage stats
    const boardSnap = await getDocs(collection(db, 'boards'));
    const boardsByOwner = {};
    boardSnap.docs.forEach(d => {
      const data = d.data();
      const owner = data.ownerUid || '';
      if (!boardsByOwner[owner]) boardsByOwner[owner] = [];
      boardsByOwner[owner].push({ id: d.id, ...data });
    });

    // Count submissions + file sizes per user (parallel)
    const usageMap = {};
    const statPromises = [];
    for (const [uid, boards] of Object.entries(boardsByOwner)) {
      usageMap[uid] = { boards: boards.length, submissions: 0, storageBytes: 0 };
      for (const b of boards) {
        statPromises.push(
          getDocs(collection(db, 'boards', b.id, 'submissions'))
            .then(snap => {
              usageMap[uid].submissions += snap.size;
              snap.docs.forEach(d => {
                const data = d.data();
                // assignment files
                if (data.files) data.files.forEach(f => { usageMap[uid].storageBytes += (f.size || 0); });
                // classify images (estimate ~500KB if no size field)
                if (data.imagePath && !data.files) usageMap[uid].storageBytes += 500000;
              });
            })
            .catch(() => {})
        );
      }
    }
    await Promise.all(statPromises);

    // Sort: pending first, then by usage (storage) descending
    users.sort((a, b) => {
      const order = { pending: 0, approved: 1, admin: 1, rejected: 2 };
      if (order[a.role] !== order[b.role]) return order[a.role] - order[b.role];
      const aUsage = usageMap[a.uid]?.storageBytes || 0;
      const bUsage = usageMap[b.uid]?.storageBytes || 0;
      if (aUsage !== bUsage) return bUsage - aUsage;
      return (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0);
    });

    if (!users.length) {
      container.innerHTML = '<div class="empty-state">등록된 회원이 없습니다</div>';
      return;
    }

    const activeUsers = users.filter(u => u.role !== 'rejected');
    const rejectedUsers = users.filter(u => u.role === 'rejected');

    // Total stats
    const totalBoards = boardSnap.docs.length;
    const totalSubs = Object.values(usageMap).reduce((s, u) => s + u.submissions, 0);
    const totalStorage = Object.values(usageMap).reduce((s, u) => s + u.storageBytes, 0);

    function renderUserCard(u) {
      const date = u.createdAt ? new Date(u.createdAt.toMillis()).toLocaleDateString('ko-KR') : '';
      const isSelf = u.uid === currentUser.uid;
      const usage = usageMap[u.uid];

      let actions = '';
      if (!isSelf) {
        if (u.role === 'pending') {
          actions = `<button class="btn-approve" data-uid="${escapeHtml(u.uid)}">승인</button>
                     <button class="btn-reject" data-uid="${escapeHtml(u.uid)}">거부</button>`;
        } else if (u.role === 'approved') {
          actions = `<button class="btn-revoke" data-uid="${escapeHtml(u.uid)}">승인 취소</button>`;
        } else if (u.role === 'rejected') {
          actions = `<button class="btn-approve" data-uid="${escapeHtml(u.uid)}">승인</button>`;
        }
      }

      const usageHtml = usage
        ? `<div class="user-usage">보드 <strong>${usage.boards}</strong> · 제출물 <strong>${usage.submissions}</strong> · ${formatSize(usage.storageBytes)}</div>`
        : '<div class="user-usage">사용량 없음</div>';

      return `<div class="user-card">
        <div class="user-info">
          <span class="user-info-name" data-uid="${escapeHtml(u.uid)}">${escapeHtml(u.displayName || '(이름 없음)')}</span>
          <button class="btn-edit-name" data-uid="${escapeHtml(u.uid)}" data-name="${escapeHtml(u.displayName || '')}" title="이름 수정">✏️</button>
          <span class="user-info-email">${escapeHtml(u.email)}</span>
          <span class="user-info-date">${date}</span>
          ${usageHtml}
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="user-status ${ROLE_CLS[u.role] || ''}">${ROLE_LABEL[u.role] || u.role}</span>
          <div class="user-actions">${actions}</div>
        </div>
      </div>`;
    }

    const summaryHtml = `<div class="usage-summary">
      <span>보드 <strong>${totalBoards}</strong></span>
      <span>제출물 <strong>${totalSubs}</strong></span>
      <span>Storage <strong>${formatSize(totalStorage)}</strong></span>
      <span>교사 <strong>${activeUsers.filter(u => u.role === 'approved' || u.role === 'admin').length}</strong></span>
      <a href="https://console.firebase.google.com/project/easyup-1604e/usage" target="_blank" class="usage-console-link">📊 트래픽·비용 (콘솔)</a>
    </div>`;

    container.innerHTML = summaryHtml + (activeUsers.length
      ? activeUsers.map(renderUserCard).join('')
      : '<div class="empty-state">활성 회원이 없습니다</div>');

    const rejectedContainer = document.getElementById('users-list-rejected');
    rejectedContainer.innerHTML = rejectedUsers.length
      ? rejectedUsers.map(renderUserCard).join('')
      : '<div class="empty-state">거부/취소된 회원이 없습니다</div>';

    const badge = document.getElementById('rejected-count-badge');
    badge.textContent = rejectedUsers.length > 0 ? rejectedUsers.length : '';
  } catch (e) {
    console.error(e);
    container.innerHTML = '<div class="empty-state">불러오기 실패</div>';
  }
}

window.switchUsersTab = function(tab) {
  document.querySelectorAll('.users-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('users-list').style.display = tab === 'active' ? '' : 'none';
  document.getElementById('users-list-rejected').style.display = tab === 'rejected' ? '' : 'none';
};

/** Helper: update user field and reload list */
async function updateUser(uid, data, msg) {
  try {
    await updateDoc(doc(db, 'users', uid), data);
    toast(msg);
    loadUsers();
  } catch (e) { toast('처리 실패'); }
}

// Event delegation for user management (covers both active + rejected lists)
document.getElementById('users-view').addEventListener('click', (e) => {
  const editNameBtn = e.target.closest('.btn-edit-name');
  if (editNameBtn) {
    const newName = prompt('표시 이름 변경', editNameBtn.dataset.name);
    if (newName !== null && newName.trim() !== editNameBtn.dataset.name) {
      updateUser(editNameBtn.dataset.uid, { displayName: newName.trim() }, '이름 변경됨');
    }
    return;
  }
  const approveBtn = e.target.closest('.btn-approve');
  if (approveBtn) { updateUser(approveBtn.dataset.uid, { role: 'approved' }, '승인 완료'); return; }

  const rejectBtn = e.target.closest('.btn-reject');
  if (rejectBtn) { updateUser(rejectBtn.dataset.uid, { role: 'rejected' }, '거부 완료'); return; }

  const revokeBtn = e.target.closest('.btn-revoke');
  if (revokeBtn) { updateUser(revokeBtn.dataset.uid, { role: 'rejected' }, '승인 취소됨'); return; }
});

// ══════════════════════════════════════
//  ROUTING
// ══════════════════════════════════════
/** Parse hash and navigate. Returns true if a route matched. */
function handleRoute() {
  const hash = location.hash.slice(1);
  // Read-only book route (no auth needed)
  if (hash.startsWith('book/')) {
    const parts = hash.split('/');
    showReadOnlyBook(parts[1].toUpperCase(), parts[2] || '');
    return true;
  }
  // Student routes (no auth needed)
  if (hash.startsWith('join/') || hash.startsWith('gallery/') || hash.startsWith('inquiry/') || hash.startsWith('classify/')) {
    handleStudentRoute(hash.split('/')[1].toUpperCase());
    return true;
  }
  // Teacher routes (auth required)
  if (!currentUser) return false;
  if (hash.startsWith('board/')) { openBoard(hash.split('/')[1].toUpperCase()); return true; }
  if (hash.startsWith('created/')) {
    currentBoardCode = hash.split('/')[1].toUpperCase();
    document.getElementById('created-code').textContent = currentBoardCode;
    showView('created-view');
    return true;
  }
  if (hash === 'dashboard') { showView('dashboard-view'); loadMyBoards(); return true; }
  if (hash === 'users' && currentUserRole === 'admin') { showView('users-view'); return true; }
  return false;
}

/** Read-only book view: no login, no editing — just the book */
async function showReadOnlyBook(code, workspaceId) {
  try {
    const boardDoc = await getDoc(doc(db, 'boards', code));
    if (!boardDoc.exists()) { toast('존재하지 않는 코드입니다'); return; }
    currentBoard = boardDoc.data();
    currentBoard.code = code;
    currentBoardCode = code;

    // Load all submissions
    const snap = await getDocs(query(collection(db, 'boards', code, 'submissions'), orderBy('createdAt', 'desc')));
    CL.allCards = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    CL.workspaceId = workspaceId;
    CL.currentPage = 'workspace';
    CL.searchQuery = '';
    CL.isTeacher = false;
    clBuildTree();
    clPreloadImages();

    // Hide all views and render book overlay directly
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.getElementById('loading-view').style.display = 'none';

    const pages = clBuildBookPages();
    CL.bookPage = 0;
    CL.bookPages = pages;

    let overlay = document.getElementById('cl-book-overlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'cl-book-overlay';
    overlay.classList.add('clb-readonly');
    overlay.innerHTML = `
      <div class="clb-container">
        <div class="clb-page-wrapper">
          ${clRenderBookPage(pages[0], 0, pages.length)}
        </div>
        <div class="clb-controls">
          <div class="clb-pdf-btns">
            <button class="clb-download-pdf" data-mode="normal" title="인쇄 / PDF 저장">🖨 인쇄</button>
            <button class="clb-download-pdf" data-mode="booklet" title="소책자 인쇄 (접어서 제본)">📖 소책자</button>
          </div>
          <div class="clb-nav">
            <button class="clb-prev" disabled>‹</button>
            <span class="clb-page-num">1 / ${pages.length}</span>
            <button class="clb-next" ${pages.length <= 1 ? 'disabled' : ''}>›</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('clb-open'));
    CL._bookParentView = null;
    CL._bookContainerId = null;
  } catch (e) {
    console.error(e);
    toast('책을 불러올 수 없습니다');
  }
}

async function handleStudentRoute(code) {
  try {
    const boardDoc = await getDoc(doc(db, 'boards', code));
    if (!boardDoc.exists()) { toast('존재하지 않는 코드입니다'); return; }
    currentBoard = boardDoc.data();
    currentBoard.code = code;
    currentBoardCode = code;

    if (currentBoard.status === 'private') {
      document.getElementById('private-board-title').textContent = currentBoard.title;
      showView('private-view');
      return;
    }

    const savedName = localStorage.getItem(`easyup_name_${code}`);
    if (savedName) {
      studentName = savedName;
      showGallery();
    } else {
      showNameView();
    }
  } catch (e) {
    console.error(e);
    toast('오류가 발생했습니다');
  }
}

// ══════════════════════════════════════
//  STUDENT: NAME ENTRY
// ══════════════════════════════════════
function showNameView() {
  document.getElementById('name-board-title').textContent = currentBoard.title;
  setTextVisibility('name-board-desc', currentBoard.description);
  renderDeadline('name-deadline-notice', currentBoard.deadline);
  document.getElementById('student-name-input').value = '';

  // Show team select for classify team boards
  const teamSelectDiv = document.getElementById('name-team-select');
  const teamSelect = document.getElementById('student-team-select');
  if (currentBoard?.type === 'classify' && currentBoard?.settings?.groupMode === 'team') {
    const groups = currentBoard.groups || {};
    const members = currentBoard.members || {};
    teamSelect.innerHTML = Object.entries(groups)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([gId, g]) => {
        const gMembers = Object.entries(members).filter(([, m]) => m.groupId === gId).map(([, m]) => m.name);
        const memberStr = gMembers.length > 0 ? ` (${gMembers.join(', ')})` : ' (아직 없음)';
        return `<option value="${gId}">${g.name}${memberStr}</option>`;
      })
      .join('');
    // Restore saved group selection
    const savedGroupId = localStorage.getItem(`easyup_group_${currentBoardCode}`);
    if (savedGroupId && groups[savedGroupId]) teamSelect.value = savedGroupId;
    teamSelectDiv.style.display = 'block';
  } else {
    teamSelectDiv.style.display = 'none';
  }

  showView('name-view');
  location.hash = `join/${currentBoardCode}`;
  setTimeout(() => document.getElementById('student-name-input').focus(), 100);
}

window.enterBoard = async function() {
  const name = document.getElementById('student-name-input').value.trim();
  if (!name) { toast('이름을 입력하세요'); return; }

  // For classify team boards, save team selection
  if (currentBoard?.type === 'classify' && currentBoard?.settings?.groupMode === 'team') {
    const teamSelect = document.getElementById('student-team-select');
    const groupId = teamSelect?.value;
    if (!groupId) { toast('모둠을 선택하세요'); return; }
    localStorage.setItem(`easyup_group_${currentBoardCode}`, groupId);
  }

  studentName = name;
  localStorage.setItem(`easyup_name_${currentBoardCode}`, name);
  showGallery();
};

document.getElementById('student-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enterBoard();
});
document.getElementById('change-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveChangedName();
});

window.changeStudentName = function() {
  document.getElementById('change-name-input').value = studentName;
  const modal = document.getElementById('change-name-modal');
  modal.style.display = 'flex';
  history.pushState({ modal: true }, '');
  setTimeout(() => document.getElementById('change-name-input').focus(), 100);
};

window.saveChangedName = async function() {
  const name = document.getElementById('change-name-input').value.trim();
  if (!name) { toast('이름을 입력하세요'); return; }
  studentName = name;
  localStorage.setItem(`easyup_name_${currentBoardCode}`, name);
  document.getElementById('gallery-student-name').textContent = name;
  document.getElementById('inquiry-gallery-student-name').textContent = name;
  const clNameEl = document.getElementById('classify-gallery-student-name');
  if (clNameEl) {
    const settings = currentBoard?.settings || {};
    if (settings.groupMode === 'team') {
      const savedGroupId = localStorage.getItem(`easyup_group_${currentBoardCode}`);
      const groupName = savedGroupId && currentBoard.groups?.[savedGroupId]?.name;
      clNameEl.textContent = groupName ? `${name} (${groupName})` : name;
    } else {
      clNameEl.textContent = name;
    }
  }
  closeModal('change-name-modal');

  // Update name in all my submissions and board member entry
  if (currentBoardCode) {
    try {
      const subs = await getDocs(query(collection(db, 'boards', currentBoardCode, 'submissions'), where('deviceId', '==', deviceId)));
      await Promise.all(subs.docs.map(d => updateDoc(d.ref, { name })));
      // Update board member name
      if (currentBoard?.members?.[deviceId]) {
        await updateDoc(doc(db, 'boards', currentBoardCode), { [`members.${deviceId}.name`]: name });
      }
    } catch (e) { console.error('Name update failed:', e); }
  }
  toast('이름이 변경되었습니다');
};

// ══════════════════════════════════════
//  STUDENT: GALLERY BOARD
// ══════════════════════════════════════
function showGallery() {
  // Branch by board type
  if (currentBoard.type === 'inquiry') {
    showInquiryGallery();
    return;
  }
  if (currentBoard.type === 'classify') {
    showClassifyGallery();
    return;
  }

  document.getElementById('gallery-title').textContent = currentBoard.title;
  setTextVisibility('gallery-desc', currentBoard.description);
  document.getElementById('gallery-student-name').textContent = studentName;
  renderDeadline('gallery-deadline', currentBoard.deadline);

  // 마감 시 플로팅 제출 버튼 숨기기
  const fab = document.querySelector('#gallery-view .fab');
  if (fab) fab.style.display = isBoardClosed() ? 'none' : '';

  showView('gallery-view');
  location.hash = `gallery/${currentBoardCode}`;

  if (unsubscribeGallery) unsubscribeGallery();
  unsubscribeGallery = onSnapshot(submissionsQuery(currentBoardCode), (snapshot) => {
    galleryDocs = snapshot.docs;
    renderGallery(snapshot.docs);
  });

  // Board doc listener for real-time allowPeek sync
  if (unsubscribeBoardDoc) unsubscribeBoardDoc();
  unsubscribeBoardDoc = onSnapshot(doc(db, 'boards', currentBoardCode), (snap) => {
    if (snap.exists()) {
      const prev = currentBoard.allowPeek;
      currentBoard.allowPeek = snap.data().allowPeek;
      currentBoard.status = snap.data().status;
      if (prev !== currentBoard.allowPeek && galleryDocs.length) renderGallery(galleryDocs);
    }
  });
}

function renderGallery(docs) {
  // 서로보기 차단 시 자기 제출물만 표시
  if (currentBoard?.allowPeek === false) {
    docs = docs.filter(d => d.data().deviceId === deviceId);
  }
  const grid = document.getElementById('gallery-grid');
  document.getElementById('gallery-count').textContent = `${docs.length}개 제출물`;

  if (docs.length === 0) {
    grid.innerHTML = '<div class="empty-state">아직 제출물이 없습니다.<br>첫 번째로 제출해보세요!</div>';
    return;
  }

  grid.innerHTML = docs.map(d => {
    const data = d.data();
    const isMine = data.deviceId === deviceId;
    const time = data.createdAt ? formatDateShort(data.createdAt.toDate()) : '';
    const cfg = TYPE_CONFIG[data.type] || {};

    let preview = '';
    if (data.type === 'url') {
      try { preview = `<div class="card-url">${new URL(data.content).hostname}</div>`; }
      catch { preview = `<div class="card-url">${escapeHtml(data.content)}</div>`; }
    } else if (data.type === 'text') {
      preview = `<div class="card-text">${escapeHtml(truncate(data.content, 120))}</div>`;
    } else if (data.files?.length) {
      preview = renderFileThumbnailHtml(data.files);
    }

    const updated = data.updatedAt ? ' · 수정됨' : '';
    // Use data-id attribute instead of inline onclick with string interpolation (XSS safe)
    return `
      <div class="gallery-card ${isMine ? 'gallery-card-mine' : ''}" data-id="${escapeHtml(d.id)}">
        ${isMine ? '<div class="mine-badge">내 제출</div>' : ''}
        <div class="card-type-icon">${cfg.icon || ''}</div>
        <h3 class="card-title">${escapeHtml(data.title || '(제목 없음)')}</h3>
        ${preview}
        ${data.memo ? `<div class="card-memo">💬 ${escapeHtml(data.memo)}</div>` : ''}
        <div class="card-comment-count" data-sub-id="${escapeHtml(d.id)}"></div>
        <div class="card-footer">
          <span class="card-author">${escapeHtml(data.name)}</span>
          <span class="card-time">${time}${updated}</span>
        </div>
        ${isMine && !isBoardClosed() ? `
          <div class="card-actions">
            <button class="btn-icon btn-edit" data-id="${escapeHtml(d.id)}" title="수정">✏️</button>
            <button class="btn-icon btn-icon-danger btn-del" data-id="${escapeHtml(d.id)}" title="삭제">🗑</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
  loadCommentCounts(docs.map(d => d.id));
}

// Event delegation for gallery (XSS-safe, no inline onclick with IDs)
document.getElementById('gallery-grid').addEventListener('click', (e) => {
  const editBtn = e.target.closest('.btn-edit');
  if (editBtn) { e.stopPropagation(); editMySubmission(editBtn.dataset.id); return; }

  const delBtn = e.target.closest('.btn-del');
  if (delBtn) { e.stopPropagation(); removeSubmission(delBtn.dataset.id, { checkOwnership: true }); return; }

  const card = e.target.closest('.gallery-card');
  if (card?.dataset.id) openDetail(card.dataset.id);
});

// ── Detail Modal ──
async function openDetail(submissionId) {
  try {
    // Use cached docs if available, otherwise fetch
    currentDetailIndex = galleryDocs.findIndex(d => d.id === submissionId);
    let data;
    if (currentDetailIndex >= 0) {
      data = galleryDocs[currentDetailIndex].data();
    } else {
      const subDoc = await getDoc(doc(db, 'boards', currentBoardCode, 'submissions', submissionId));
      if (!subDoc.exists()) return;
      data = subDoc.data();
    }

    document.getElementById('detail-title').textContent = data.title || '(제목 없음)';

    // Navigation buttons
    document.getElementById('detail-prev').style.display = currentDetailIndex > 0 ? '' : 'none';
    document.getElementById('detail-next').style.display = currentDetailIndex >= 0 && currentDetailIndex < galleryDocs.length - 1 ? '' : 'none';

    let html = `<div class="detail-meta">
      <span class="detail-author">${escapeHtml(data.name)}</span>
      <span class="detail-time">${data.createdAt ? formatDate(data.createdAt.toDate()) : ''}</span>
    </div>`;

    if (data.type === 'url') {
      const safeUrl = escapeHtml(sanitizeUrl(data.content));
      html += `<div class="detail-content"><a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a></div>`;
    } else if (data.type === 'text') {
      html += `<div class="detail-content detail-text-content">${escapeHtml(data.content)}</div>`;
    }

    html += renderFileLinksHtml(data.files);
    if (data.memo) html += `<div class="detail-memo">💬 ${escapeHtml(data.memo)}</div>`;

    // Comments section
    html += `<div class="detail-comments">
      <h4 class="comments-title">💬 댓글 <span id="comment-count"></span></h4>
      <div id="comments-list"></div>
      <div class="comment-input-area">
        <textarea id="comment-input" placeholder="댓글을 입력하세요" rows="2"></textarea>
        <button class="btn btn-primary btn-small" id="comment-submit-btn" data-submission-id="${escapeHtml(submissionId)}">등록</button>
      </div>
    </div>`;

    document.getElementById('detail-body').innerHTML = html;

    // Setup comments real-time listener
    setupCommentsListener(submissionId);

    // Only push history on first open, not on navigation within modal
    const modal = document.getElementById('detail-modal');
    if (modal.style.display !== 'flex') {
      modal.style.display = 'flex';
      openModalHistory();
    }
  } catch (e) {
    console.error(e);
  }
}

function navigateDetail(direction) {
  const newIndex = currentDetailIndex + direction;
  if (newIndex < 0 || newIndex >= galleryDocs.length) return;
  cleanupComments();
  openDetail(galleryDocs[newIndex].id);
}

document.getElementById('detail-prev').addEventListener('click', () => navigateDetail(-1));
document.getElementById('detail-next').addEventListener('click', () => navigateDetail(1));

document.addEventListener('keydown', (e) => {
  if (document.getElementById('detail-modal').style.display !== 'flex') return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') navigateDetail(-1);
  if (e.key === 'ArrowRight') navigateDetail(1);
});

{
  let swipeStartX = 0, swipeStartY = 0;
  const detailContent = document.querySelector('#detail-modal .modal-content');
  detailContent.addEventListener('touchstart', (e) => {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
  }, { passive: true });
  detailContent.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      navigateDetail(dx > 0 ? -1 : 1);
    }
  }, { passive: true });
}

function cleanupComments() {
  if (unsubscribeComments) { unsubscribeComments(); unsubscribeComments = null; }
}

window.closeDetailModal = function() {
  cleanupComments();
  closeModal('detail-modal');
};

// ── Comments ──
async function loadCommentCounts(submissionIds) {
  const code = currentBoardCode;
  await Promise.all(submissionIds.map(async (id) => {
    const el = document.querySelector(`.card-comment-count[data-sub-id="${id}"]`);
    if (!el) return;
    try {
      const snap = await getCountFromServer(collection(db, 'boards', code, 'submissions', id, 'comments'));
      const count = snap.data().count;
      el.innerHTML = count > 0 ? `<span class="card-comment-badge">💬 ${count}</span>` : '';
    } catch (_) {}
  }));
}

function isCurrentBoardTeacher() {
  return currentUser && currentBoard && currentBoard.ownerUid === currentUser.uid;
}

function setupCommentsListener(submissionId) {
  cleanupComments();
  const commentsRef = collection(db, 'boards', currentBoardCode, 'submissions', submissionId, 'comments');
  const q = query(commentsRef, orderBy('createdAt', 'asc'));
  unsubscribeComments = onSnapshot(q, (snapshot) => {
    const list = document.getElementById('comments-list');
    const countEl = document.getElementById('comment-count');
    if (!list) return;
    const activeDocs = snapshot.docs.filter(d => !d.data().deleted);
    countEl.textContent = activeDocs.length > 0 ? `(${activeDocs.length})` : '';
    if (snapshot.docs.length === 0) {
      list.innerHTML = '<div class="comments-empty">아직 댓글이 없습니다</div>';
      return;
    }
    const teacher = isCurrentBoardTeacher();
    list.innerHTML = snapshot.docs.map(d => {
      const c = d.data();
      const isMine = c.deviceId === deviceId;
      const canEdit = isMine || teacher;
      const time = c.createdAt ? formatDateShort(c.createdAt.toDate()) : '';

      // Deleted comment
      if (c.deleted) {
        if (!teacher) return '';
        const delTime = c.deletedAt ? formatDateShort(c.deletedAt.toDate()) : '';
        return `<div class="comment-item comment-item-deleted">
          <div class="comment-meta">
            <span class="comment-author">${escapeHtml(c.name)}</span>
            <span class="comment-time">${time}</span>
          </div>
          <div class="comment-content comment-deleted-text">삭제됨 (${escapeHtml(c.deletedBy || '')} · ${delTime})</div>
          <div class="comment-original">원문: ${escapeHtml(c.content)}</div>
          ${c.editHistory?.length ? renderEditHistory(c.editHistory) : ''}
        </div>`;
      }

      // Edit history (teacher only)
      let historyHtml = '';
      if (teacher && c.editHistory?.length) {
        historyHtml = renderEditHistory(c.editHistory);
      }

      return `<div class="comment-item ${isMine ? 'comment-item-mine' : ''}" data-comment-id="${escapeHtml(d.id)}">
        <div class="comment-meta">
          <span class="comment-author">${escapeHtml(c.name)}${isMine ? ' (나)' : ''}${c.editedAt ? ' · <span class="comment-edited">수정됨</span>' : ''}</span>
          <span class="comment-time">${time}${canEdit ? `
            <button class="comment-action-btn comment-edit-btn" data-comment-id="${escapeHtml(d.id)}" title="수정">✏️</button>
            <button class="comment-action-btn comment-del-btn" data-comment-id="${escapeHtml(d.id)}" title="삭제">🗑</button>
          ` : ''}</span>
        </div>
        <div class="comment-content" id="comment-content-${escapeHtml(d.id)}">${escapeHtml(c.content)}</div>
        ${historyHtml}
      </div>`;
    }).join('');
    list.scrollTop = list.scrollHeight;
  });
}

function renderEditHistory(history) {
  return `<details class="comment-history">
    <summary>수정 이력 (${history.length})</summary>
    ${history.map(h => {
      const t = h.editedAt?.toDate ? formatDateShort(h.editedAt.toDate()) : '';
      return `<div class="comment-history-item"><span class="comment-history-time">${t} (${escapeHtml(h.editedBy || '')})</span> ${escapeHtml(h.content)}</div>`;
    }).join('')}
  </details>`;
}

async function submitComment(submissionId) {
  const input = document.getElementById('comment-input');
  const content = input.value.trim();
  if (!content) { toast('댓글을 입력하세요'); return; }

  // Check if editing existing comment
  const editId = input.dataset.editingCommentId;
  if (editId) {
    await saveCommentEdit(submissionId, editId, content);
    input.dataset.editingCommentId = '';
    input.placeholder = '댓글을 입력하세요';
    document.getElementById('comment-edit-cancel')?.remove();
    input.value = '';
    return;
  }

  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const teacher = isCurrentBoardTeacher();
  try {
    await setDoc(doc(db, 'boards', currentBoardCode, 'submissions', submissionId, 'comments', id), {
      content,
      name: teacher ? (currentUser.displayName || currentUser.email) : studentName,
      deviceId,
      isTeacher: teacher || false,
      createdAt: serverTimestamp()
    });
    input.value = '';
  } catch (e) {
    console.error(e);
    toast('댓글 등록 실패');
  }
}

async function saveCommentEdit(submissionId, commentId, newContent) {
  const ref = doc(db, 'boards', currentBoardCode, 'submissions', submissionId, 'comments', commentId);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const old = snap.data();
    const editor = isCurrentBoardTeacher() ? '교사' : old.name;
    const editHistory = (old.editHistory || []).slice(-19);
    editHistory.push({ content: old.content, editedAt: old.editedAt || old.createdAt, editedBy: editor });
    await updateDoc(ref, {
      content: newContent,
      editedAt: serverTimestamp(),
      editedBy: editor,
      editHistory
    });
    toast('댓글이 수정되었습니다');
  } catch (e) {
    console.error(e);
    toast('댓글 수정 실패');
  }
}

async function deleteComment(submissionId, commentId) {
  const ref = doc(db, 'boards', currentBoardCode, 'submissions', submissionId, 'comments', commentId);
  try {
    const deleter = isCurrentBoardTeacher() ? '교사' : '작성자';
    await updateDoc(ref, {
      deleted: true,
      deletedAt: serverTimestamp(),
      deletedBy: deleter
    });
    toast('댓글이 삭제되었습니다');
  } catch (e) {
    console.error(e);
    toast('댓글 삭제 실패');
  }
}

function startCommentEdit(commentId) {
  const contentEl = document.getElementById(`comment-content-${commentId}`);
  if (!contentEl) return;
  const input = document.getElementById('comment-input');
  const btn = document.getElementById('comment-submit-btn');
  input.value = contentEl.textContent;
  input.dataset.editingCommentId = commentId;
  input.placeholder = '댓글 수정 중... (ESC로 취소)';
  input.focus();
  btn.textContent = '수정';
  // Add cancel button if not exists
  if (!document.getElementById('comment-edit-cancel')) {
    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'comment-edit-cancel';
    cancelBtn.className = 'btn btn-small';
    cancelBtn.textContent = '취소';
    cancelBtn.onclick = () => cancelCommentEdit();
    btn.parentElement.appendChild(cancelBtn);
  }
}

function cancelCommentEdit() {
  const input = document.getElementById('comment-input');
  const btn = document.getElementById('comment-submit-btn');
  input.value = '';
  input.dataset.editingCommentId = '';
  input.placeholder = '댓글을 입력하세요';
  btn.textContent = '등록';
  document.getElementById('comment-edit-cancel')?.remove();
}

// Comment event delegation on detail-modal
document.getElementById('detail-modal').addEventListener('click', (e) => {
  const submitBtn = e.target.closest('#comment-submit-btn');
  if (submitBtn) { submitComment(submitBtn.dataset.submissionId); return; }

  const editBtn = e.target.closest('.comment-edit-btn');
  if (editBtn) { startCommentEdit(editBtn.dataset.commentId); return; }

  const delBtn = e.target.closest('.comment-del-btn');
  if (delBtn) {
    const subBtn = document.getElementById('comment-submit-btn');
    deleteComment(subBtn.dataset.submissionId, delBtn.dataset.commentId);
    return;
  }
});

// Enter key to submit comment (Shift+Enter for newline), ESC to cancel edit
document.getElementById('detail-modal').addEventListener('keydown', (e) => {
  if (e.target.id === 'comment-input') {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const btn = document.getElementById('comment-submit-btn');
      if (btn) submitComment(btn.dataset.submissionId);
    }
    if (e.key === 'Escape' && e.target.dataset.editingCommentId) {
      cancelCommentEdit();
    }
  }
});

// ══════════════════════════════════════
//  STUDENT: SUBMIT MODAL
// ══════════════════════════════════════
function resetSubmitForm() {
  editingSubmissionId = null;
  existingFiles = null;
  teacherEditMode = false;
  selectedFiles = [];
  document.getElementById('submit-title-input').value = '';
  document.getElementById('submit-url').value = '';
  document.getElementById('submit-text').value = '';
  document.getElementById('submit-memo').value = '';
  document.getElementById('submit-file').value = '';
  document.getElementById('file-list').innerHTML = '';
  document.getElementById('submit-btn').textContent = '제출하기';
}

window.openSubmitForm = function() {
  if (isBoardClosed()) { toast('마감된 보드입니다. 제출할 수 없습니다.'); return; }
  resetSubmitForm();
  document.getElementById('submit-modal-title').textContent = '과제 제출';
  setupTabs();
  document.getElementById('submit-modal').style.display = 'flex';
  openModalHistory();
  setTimeout(() => document.getElementById('submit-title-input').focus(), 100);
};

function setupTabs() {
  const tabs = document.getElementById('submit-tabs');
  tabs.innerHTML = '';
  const types = [];
  if (currentBoard.allowUrl) types.push('url');
  if (currentBoard.allowText) types.push('text');
  if (currentBoard.allowFile) types.push('file');

  types.forEach((t, i) => {
    const label = document.createElement('label');
    label.className = 'radio-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'submit-type';
    radio.value = t;
    if (i === 0) radio.checked = true;
    radio.addEventListener('change', () => selectTab(t));
    label.appendChild(radio);
    label.appendChild(document.createTextNode(' ' + TYPE_CONFIG[t].label));
    tabs.appendChild(label);
  });

  if (types.length > 0) selectTab(types[0]);
}

window.closeSubmitModal = function() { closeModal('submit-modal'); };

function selectTab(type) {
  document.querySelectorAll('input[name="submit-type"]').forEach(r => {
    r.checked = r.value === type;
  });
  document.querySelectorAll('.submit-section').forEach(s => s.style.display = 'none');
  document.getElementById(`submit-${type}-section`).style.display = 'block';
  window._currentSubmitType = type;
}

// ── File handling ──
document.getElementById('submit-file').addEventListener('change', function(e) { addFiles(e.target.files); });
const dropZone = document.getElementById('file-drop-zone');
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('dragover'); });
dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); addFiles(e.dataTransfer.files); });

function addFiles(fileList) {
  for (const f of fileList) {
    if (f.size > 1024 * 1024 * 1024) { toast(`${f.name}은 1GB를 초과합니다`); continue; }
    if (!selectedFiles.find(sf => sf.name === f.name && sf.size === f.size)) selectedFiles.push(f);
  }
  renderFileList();
}

function renderFileList() {
  document.getElementById('file-list').innerHTML = selectedFiles.map((f, i) => `
    <div class="file-item">
      <span>📄 ${escapeHtml(f.name)} (${formatSize(f.size)})</span>
      <button data-idx="${i}" class="file-remove-btn">✕</button>
    </div>
  `).join('');
}

document.getElementById('file-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.file-remove-btn');
  if (!btn) return;
  selectedFiles.splice(Number(btn.dataset.idx), 1);
  document.getElementById('submit-file').value = '';
  renderFileList();
});

// ── Submit ──
window.submitAssignment = async function() {
  const title = document.getElementById('submit-title-input').value.trim();
  if (!title) { toast('제목을 입력하세요'); return; }

  const type = window._currentSubmitType;
  const memo = document.getElementById('submit-memo').value.trim();
  const btn = document.getElementById('submit-btn');
  const progressBar = document.getElementById('submit-progress');

  let content = '';
  let files = [];

  if (type === 'url') {
    content = sanitizeUrl(document.getElementById('submit-url').value.trim());
    if (!content) { toast('올바른 URL을 입력하세요'); return; }
  } else if (type === 'text') {
    content = document.getElementById('submit-text').value.trim();
    if (!content) { toast('텍스트를 입력하세요'); return; }
  } else if (type === 'file') {
    if (selectedFiles.length === 0 && !editingSubmissionId) { toast('파일을 선택하세요'); return; }
  }

  btn.disabled = true;
  btn.textContent = '제출 중...';

  try {
    if (type === 'file' && selectedFiles.length > 0) {
      progressBar.style.display = 'block';
      const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
      let uploadedSize = 0;

      for (const file of selectedFiles) {
        const filePath = `boards/${currentBoardCode}/${Date.now()}_${file.name}`;
        const storageRef = ref(storage, filePath);
        const uploadTask = uploadBytesResumable(storageRef, file);

        await new Promise((resolve, reject) => {
          uploadTask.on('state_changed',
            (snap) => {
              const pct = ((uploadedSize + snap.bytesTransferred) / totalSize) * 100;
              document.getElementById('progress-fill').style.width = pct + '%';
            },
            reject,
            async () => {
              const url = await getDownloadURL(uploadTask.snapshot.ref);
              files.push({ name: file.name, size: file.size, url, path: filePath });
              uploadedSize += file.size;
              resolve();
            }
          );
        });
      }
    }

    if (editingSubmissionId) {
      // Editing: preserve original name/deviceId, only update content fields
      if (type === 'file' && files.length === 0 && existingFiles?.length) files = existingFiles;
      const updateData = { title, type, content, files, memo, updatedAt: serverTimestamp() };
      // Teacher edit: don't overwrite name/deviceId; Student edit: update name
      if (!teacherEditMode) {
        updateData.name = studentName;
        updateData.deviceId = deviceId;
      }
      await updateDoc(doc(db, 'boards', currentBoardCode, 'submissions', editingSubmissionId), updateData);
      editingSubmissionId = null;
      existingFiles = null;
      teacherEditMode = false;
      toast('수정 완료!');
    } else {
      const submissionData = {
        name: studentName, title, type, content, files, memo,
        deviceId, boardCode: currentBoardCode,
        createdAt: serverTimestamp()
      };
      const submissionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await setDoc(doc(db, 'boards', currentBoardCode, 'submissions', submissionId), submissionData);
      toast('제출 완료!');
    }

    closeSubmitModal();
  } catch (e) {
    console.error(e);
    toast('오류: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = editingSubmissionId ? '수정하기' : '제출하기';
    progressBar.style.display = 'none';
    document.getElementById('progress-fill').style.width = '0%';
  }
};

// ── Edit / Delete ──
/** Shared edit modal opener for both student and teacher */
function openEditModal(submissionId, data, isTeacher) {
  teacherEditMode = isTeacher;
  resetSubmitForm();
  editingSubmissionId = submissionId;
  document.getElementById('submit-modal-title').textContent =
    isTeacher ? `과제 수정 (${data.name})` : '과제 수정';
  document.getElementById('submit-title-input').value = data.title || '';
  document.getElementById('submit-memo').value = data.memo || '';
  document.getElementById('submit-btn').textContent = '수정하기';

  setupTabs();
  selectTab(data.type);

  if (data.type === 'url') document.getElementById('submit-url').value = data.content || '';
  else if (data.type === 'text') document.getElementById('submit-text').value = data.content || '';
  else if (data.type === 'file') {
    document.getElementById('file-list').innerHTML =
      '<div class="file-edit-notice">기존 파일이 유지됩니다. 새 파일을 선택하면 교체됩니다.</div>';
    existingFiles = data.files || [];
  }

  document.getElementById('submit-modal').style.display = 'flex';
  openModalHistory();
}

async function editMySubmission(submissionId) {
  if (isBoardClosed()) { toast('마감된 보드입니다. 수정할 수 없습니다.'); return; }
  try {
    const subDoc = await getDoc(doc(db, 'boards', currentBoardCode, 'submissions', submissionId));
    if (!subDoc.exists()) return;
    const data = subDoc.data();
    if (data.deviceId !== deviceId) { toast('수정 권한이 없습니다'); return; }
    openEditModal(submissionId, data, false);
  } catch (e) { console.error(e); }
}

async function removeSubmission(id, { checkOwnership = false, isTeacher = false } = {}) {
  if (!isTeacher && isBoardClosed()) { toast('마감된 보드입니다. 삭제할 수 없습니다.'); return; }
  try {
    const sub = await getDoc(doc(db, 'boards', currentBoardCode, 'submissions', id));
    if (!sub.exists()) return;
    const data = sub.data();
    if (checkOwnership && data.deviceId !== deviceId) { toast('삭제 권한이 없습니다'); return; }

    const preview = truncate(data.content || data.title || '(내용 없음)', 50);
    if (!await showConfirm(`"${preview}"\n\n삭제하시겠습니까?`)) return;

    await deleteStorageFiles(data.files);
    await deleteDoc(doc(db, 'boards', currentBoardCode, 'submissions', id));
    toast('삭제됨');
  } catch (e) { toast('삭제 실패'); }
}

// ══════════════════════════════════════
//  TEACHER: DASHBOARD
// ══════════════════════════════════════
async function loadMyBoards() {
  if (!currentUser) return;
  const container = document.getElementById('dashboard-boards');
  container.innerHTML = '<div class="empty-state"><div class="spinner"></div><p>불러오는 중...</p></div>';
  try {
    const q = query(collection(db, 'boards'), where('ownerUid', '==', currentUser.uid));
    const snapshot = await getDocs(q);
    const countPromises = snapshot.docs.map(async (d) => {
      const data = d.data();
      const countSnap = await getCountFromServer(collection(db, 'boards', d.id, 'submissions'));
      return { code: d.id, ...data, submissionCount: countSnap.data().count, createdAtMs: data.createdAt?.toMillis() || 0 };
    });
    allBoards = await Promise.all(countPromises);
    renderDashboard();
  } catch (e) { console.error(e); container.innerHTML = '<div class="empty-state">불러오기 실패</div>'; }
}

function renderDashboard() {
  const container = document.getElementById('dashboard-boards');
  // Toggle hidden button visibility
  const hiddenCount = allBoards.filter(b => b.hidden).length;
  const toggleBtn = document.getElementById('toggle-hidden-btn');
  if (toggleBtn) {
    toggleBtn.style.display = hiddenCount > 0 || showingHidden ? '' : 'none';
    toggleBtn.textContent = showingHidden ? `전체 보기` : `숨긴 보드 (${hiddenCount})`;
  }
  const search = (document.getElementById('search-boards')?.value || '').trim().toLowerCase();
  let filtered = showingHidden ? allBoards.filter(b => b.hidden) : allBoards.filter(b => !b.hidden);
  if (search) filtered = filtered.filter(b => b.title.toLowerCase().includes(search) || b.code.toLowerCase().includes(search));

  filtered.sort((a, b) => {
    if (currentSort === 'title') return currentSortDir === 'asc' ? a.title.localeCompare(b.title, 'ko') : b.title.localeCompare(a.title, 'ko');
    if (currentSort === 'submissions') return currentSortDir === 'desc' ? b.submissionCount - a.submissionCount : a.submissionCount - b.submissionCount;
    return currentSortDir === 'desc' ? b.createdAtMs - a.createdAtMs : a.createdAtMs - b.createdAtMs;
  });

  if (!filtered.length) {
    container.innerHTML = search
      ? '<div class="empty-state"><p>검색 결과가 없습니다</p></div>'
      : '<div class="empty-state"><div class="empty-state-icon">📋</div><p>아직 만든 보드가 없습니다.<br>위의 "새 보드" 버튼을 눌러 시작하세요.</p></div>';
    return;
  }

  container.innerHTML = filtered.map(b => {
    const isClosed = b.status === 'closed';
    const isPrivate = b.status === 'private';
    const isExpired = !isClosed && !isPrivate && b.deadline && new Date() > new Date(b.deadline);
    const typeBadge = b.type === 'inquiry' ? '🔬 질문판' : b.type === 'classify' ? '🗂 분류' : '📋 과제';
    let statusBadge;
    if (isPrivate) statusBadge = '<span class="badge badge-private">비공개</span>';
    else if (isClosed) statusBadge = '<span class="badge badge-expired">마감</span>';
    else if (isExpired) statusBadge = '<span class="badge badge-expired">기한초과</span>';
    else statusBadge = '<span class="badge badge-active">진행중</span>';
    const statusBtnLabel = isPrivate ? '재시작' : isClosed ? '비공개' : '마감';

    return `<div class="board-card" data-code="${escapeHtml(b.code)}">
      <div class="board-card-header">
        <h3>${escapeHtml(b.title)}</h3>
        ${statusBadge}
      </div>
      <div class="board-card-meta">
        <span>${typeBadge}</span>
        <span>제출 ${b.submissionCount}건</span>
        ${b.code ? `<span class="access-code-display">${escapeHtml(b.code)}</span>` : ''}
      </div>
      <div class="board-card-actions">
        <button class="btn btn-sm btn-secondary btn-equal btn-teacher-share" data-code="${escapeHtml(b.code)}">교사공유</button>
        <button class="btn btn-sm btn-secondary btn-equal btn-copy-link" data-code="${escapeHtml(b.code)}">학생공유</button>
        <button class="btn btn-sm btn-secondary btn-equal btn-qr" data-code="${escapeHtml(b.code)}" data-title="${escapeHtml(b.title)}">학생QR</button>
        <a href="${getJoinLink(b.code)}" target="_blank" class="btn btn-sm btn-secondary btn-equal">미리보기</a>
        <button class="btn btn-sm btn-secondary btn-equal btn-edit-board" data-code="${escapeHtml(b.code)}">편집</button>
        <button class="btn btn-sm btn-secondary btn-equal btn-open-board" data-code="${escapeHtml(b.code)}">결과</button>
        <button class="btn btn-sm btn-danger-light btn-equal btn-toggle-status" data-code="${escapeHtml(b.code)}">${statusBtnLabel}</button>
        <button class="btn btn-sm btn-secondary btn-equal btn-duplicate" data-code="${escapeHtml(b.code)}">복제</button>
        <button class="btn btn-sm btn-secondary btn-equal btn-toggle-hidden" data-code="${escapeHtml(b.code)}">${b.hidden ? '꺼내기' : '숨기기'}</button>
        <button class="btn btn-sm btn-danger-light btn-equal btn-del-board" data-code="${escapeHtml(b.code)}" data-title="${escapeHtml(b.title)}">삭제</button>
      </div>
    </div>`;
  }).join('');
}

// Event delegation for dashboard cards (XSS-safe)
document.getElementById('dashboard-boards').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) {
    e.stopPropagation();
    const code = btn.dataset.code;
    if (btn.classList.contains('btn-teacher-share')) { copyTeacherLink(code); return; }
    if (btn.classList.contains('btn-copy-link')) { copyJoinLink(code); return; }
    if (btn.classList.contains('btn-qr')) { showQrModal(code, btn.dataset.title); return; }
    if (btn.classList.contains('btn-edit-board')) { editBoardFromList(code); return; }
    if (btn.classList.contains('btn-open-board')) { openBoard(code); return; }
    if (btn.classList.contains('btn-toggle-status')) { toggleBoardStatus(code); return; }
    if (btn.classList.contains('btn-duplicate')) { duplicateBoard(code); return; }
    if (btn.classList.contains('btn-toggle-hidden')) { toggleBoardHidden(code); return; }
    if (btn.classList.contains('btn-del-board')) { deleteBoardFromList(code, btn.dataset.title); return; }
  }
  const card = e.target.closest('.board-card');
  if (card?.dataset.code && !e.target.closest('.board-card-actions')) openBoard(card.dataset.code);
});

window.filterBoards = () => renderDashboard();
window.sortBoards = function(field) {
  currentSort = field;
  currentSortDir = field === 'title' ? 'asc' : 'desc';
  renderDashboard();
};
window.toggleShowHidden = function() {
  showingHidden = !showingHidden;
  renderDashboard();
};

function copyJoinLink(code) {
  navigator.clipboard.writeText(getJoinLink(code));
  toast('학생 참여 링크 복사됨');
}

function getTeacherLink(code) {
  return `${location.origin}${location.pathname}#board/${code}`;
}

function copyTeacherLink(code) {
  navigator.clipboard.writeText(getTeacherLink(code));
  toast('교사용 링크 복사됨');
}

async function editBoardFromList(code) {
  await openBoard(code);
  window.openEditBoardModal();
}

async function updateBoardField(code, field, newVal, successMsg, errMsg = '변경 실패') {
  const board = allBoards.find(b => b.code === code);
  if (!board) return;
  try {
    await updateDoc(doc(db, 'boards', code), { [field]: newVal });
    board[field] = newVal;
    renderDashboard();
    toast(successMsg);
  } catch (e) { toast(errMsg); }
}

async function toggleBoardStatus(code) {
  const board = allBoards.find(b => b.code === code);
  if (!board) return;
  // 3단계 순환: active → closed → private → active
  const next = { active: 'closed', closed: 'private', private: 'active' };
  const msg = { closed: '마감됨', private: '비공개 전환됨', active: '다시 시작됨' };
  const newStatus = next[board.status] || 'closed';

  if (newStatus === 'active' && board.deadline) {
    // 재시작 시 기한마감 제거
    try {
      await updateDoc(doc(db, 'boards', code), { status: 'active', deadline: null });
      board.status = 'active';
      board.deadline = null;
      renderDashboard();
      toast('다시 시작됨 (마감일 제거)');
    } catch (e) { toast('상태 변경 실패'); }
  } else {
    updateBoardField(code, 'status', newStatus, msg[newStatus], '상태 변경 실패');
  }
}

function toggleBoardHidden(code) {
  const board = allBoards.find(b => b.code === code);
  if (!board) return;
  const newHidden = !board.hidden;
  updateBoardField(code, 'hidden', newHidden, newHidden ? '숨김 처리됨' : '다시 표시됨');
}

async function duplicateBoard(code) {
  const board = allBoards.find(b => b.code === code);
  if (!board) return;
  const newCode = generateCode();
  const boardData = {
    title: board.title + ' (복제)', description: board.description || '', deadline: board.deadline || null,
    type: board.type, code: newCode, ownerUid: currentUser.uid,
    ownerName: currentUser.displayName || currentUser.email,
    status: 'active', hidden: false,
    createdAt: serverTimestamp()
  };
  if (board.type === 'assignment') {
    Object.assign(boardData, { allowUrl: board.allowUrl ?? true, allowText: board.allowText ?? true, allowFile: board.allowFile ?? true });
  } else if (board.type === 'inquiry') {
    boardData.categories = board.categories || Object.keys(INQUIRY_CATEGORIES);
  }
  // classify: 카테고리는 submissions로 존재하므로 보드 복제 시 카테고리도 함께 복제
  try {
    await setDoc(doc(db, 'boards', newCode), boardData);
    // classify: 카테고리 submissions 복제
    if (board.type === 'classify') {
      const subs = await getDocs(collection(db, 'boards', code, 'submissions'));
      for (const s of subs.docs) {
        const data = s.data();
        if (data.cardType === 'category') {
          await setDoc(doc(db, 'boards', newCode, 'submissions', s.id), {
            ...data, boardCode: newCode, createdAt: serverTimestamp()
          });
        }
      }
    }
    allBoards.push({ ...boardData, code: newCode, submissionCount: 0, createdAtMs: Date.now() });
    renderDashboard();
    toast('복제 완료');
  } catch (e) { toast('복제 실패'); }
}

/** Delete board and all its submissions + files */
async function deleteBoardData(code) {
  const subs = await getDocs(collection(db, 'boards', code, 'submissions'));
  await Promise.all(subs.docs.map(async (s) => {
    await deleteStorageFiles(s.data().files);
    await deleteDoc(s.ref);
  }));
  await deleteDoc(doc(db, 'boards', code));
}

async function deleteBoardFromList(code, title) {
  if (!await showConfirm(`"${title}" 보드를 삭제하시겠습니까?`)) return;
  try {
    await deleteBoardData(code);
    allBoards = allBoards.filter(b => b.code !== code);
    renderDashboard();
    toast('삭제됨');
  } catch (e) { toast('삭제 실패'); }
}

// ══════════════════════════════════════
//  TEACHER: CREATE BOARD
// ══════════════════════════════════════
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

window.selectBoardType = function(type) {
  selectedBoardType = type;
  document.querySelectorAll('.type-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  document.getElementById('assignment-options').style.display = type === 'assignment' ? 'block' : 'none';
  document.getElementById('inquiry-options').style.display = type === 'inquiry' ? 'block' : 'none';
  document.getElementById('classify-options').style.display = type === 'classify' ? 'block' : 'none';
  const titleInput = document.getElementById('board-title');
  const placeholders = { assignment: '예: 3월 독서감상문', inquiry: '예: 3단원 탐구 질문', classify: '예: 동식물 분류하기' };
  titleInput.placeholder = placeholders[type] || '';
};

// Classify mode radio toggle
document.querySelectorAll('input[name="classify-mode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    document.getElementById('classify-team-options').style.display = e.target.value === 'team' ? 'block' : 'none';
  });
});

window.createBoard = async function() {
  if (!currentUser) return;
  const title = document.getElementById('board-title').value.trim();
  if (!title) { toast('제목을 입력하세요'); return; }
  const desc = document.getElementById('board-desc').value.trim();
  const deadline = document.getElementById('board-deadline').value;

  const code = generateCode();
  const boardData = {
    title, description: desc, deadline: deadline || null,
    type: selectedBoardType,
    code, ownerUid: currentUser.uid, ownerName: currentUser.displayName || currentUser.email,
    status: 'active', hidden: false,
    createdAt: serverTimestamp()
  };

  if (selectedBoardType === 'assignment') {
    const allowUrl = document.getElementById('allow-url').checked;
    const allowText = document.getElementById('allow-text').checked;
    const allowFile = document.getElementById('allow-file').checked;
    if (!allowUrl && !allowText && !allowFile) { toast('최소 하나의 제출 방식을 선택하세요'); return; }
    Object.assign(boardData, { allowUrl, allowText, allowFile });
  } else if (selectedBoardType === 'inquiry') {
    boardData.categories = Object.keys(INQUIRY_CATEGORIES);
  }
  if (selectedBoardType === 'classify') {
    const modeRadio = document.querySelector('input[name="classify-mode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'individual';
    boardData.settings = { groupMode: mode };
    boardData.members = {};
    if (mode === 'team') {
      const groupCount = parseInt(document.getElementById('classify-group-count').value) || 6;
      const groups = {};
      for (let i = 1; i <= groupCount; i++) {
        groups[`g${i}`] = {
          name: `${i}모둠`,
          color: CL_GROUP_COLORS[(i - 1) % CL_GROUP_COLORS.length],
          members: []
        };
      }
      boardData.groups = groups;
    }
  }

  try {
    await setDoc(doc(db, 'boards', code), boardData);

    currentBoardCode = code;
    document.getElementById('created-code').textContent = code;
    showView('created-view');
    location.hash = `created/${code}`;
    toast('보드 생성 완료!');
  } catch (e) { toast('오류: ' + e.message); }
};

window.copyCode = () => { navigator.clipboard.writeText(currentBoardCode); toast('코드 복사됨'); };
window.copyLink = () => { navigator.clipboard.writeText(getJoinLink(currentBoardCode)); toast('링크 복사됨'); };
window.goToBoard = () => openBoard(currentBoardCode);
window.backToDashboard = () => { showView('dashboard-view'); location.hash = 'dashboard'; loadMyBoards(); };

window.copyBoardLink = () => {
  navigator.clipboard.writeText(getJoinLink(currentBoard.code));
  toast('링크 복사됨');
};

// ══════════════════════════════════════
//  TEACHER: BOARD VIEW
// ══════════════════════════════════════
async function openBoard(code) {
  try {
    const boardDoc = await getDoc(doc(db, 'boards', code));
    if (!boardDoc.exists()) { toast('보드를 찾을 수 없습니다'); return; }
    currentBoard = boardDoc.data();
    currentBoard.code = code;
    currentBoardCode = code;

    // Branch by board type
    if (currentBoard.type === 'inquiry') {
      showInquiryBoard(code);
      return;
    }
    if (currentBoard.type === 'classify') {
      showClassifyBoard(code);
      return;
    }

    document.getElementById('board-title-display').textContent = currentBoard.title;
    document.getElementById('board-code-badge').textContent = `코드: ${code}`;
    setTextVisibility('board-desc-display', currentBoard.description);
    updatePeekToggleBtn('board-peek-toggle');

    showView('board-view');
    location.hash = `board/${code}`;

    if (unsubscribe) unsubscribe();
    unsubscribe = onSnapshot(submissionsQuery(code), (snap) => { galleryDocs = snap.docs; renderSubmissions(snap.docs); });
  } catch (e) { toast('오류 발생'); }
}

function renderSubmissions(docs) {
  const list = document.getElementById('submissions-list');
  document.getElementById('submission-count').textContent = `총 ${docs.length}건`;
  if (!docs.length) { list.innerHTML = '<div class="empty-state">아직 제출물이 없습니다</div>'; return; }

  // Sort by sortOrder (desc) then createdAt (desc)
  const sorted = docs.map(d => ({ doc: d, data: d.data() }));
  sorted.sort((a, b) => {
    const oa = a.data.sortOrder || 0, ob = b.data.sortOrder || 0;
    if (ob !== oa) return ob - oa;
    const ta = a.data.createdAt?.toMillis?.() || 0, tb = b.data.createdAt?.toMillis?.() || 0;
    return tb - ta;
  });

  // Track sort orders for drag-drop
  assignmentSortOrders = {};
  sorted.forEach(({ doc: d, data }) => { assignmentSortOrders[d.id] = data.sortOrder || 0; });

  list.innerHTML = sorted.map(({ doc: d, data }) => {
    const time = data.createdAt ? formatDateShort(data.createdAt.toDate()) : '';
    const cfg = TYPE_CONFIG[data.type] || {};
    const updated = data.updatedAt ? ' · 수정됨' : '';

    let preview = '';
    if (data.type === 'url') {
      try { preview = `<div class="card-url">${new URL(data.content).hostname}</div>`; }
      catch { preview = `<div class="card-url">${escapeHtml(data.content)}</div>`; }
    } else if (data.type === 'text') {
      preview = `<div class="card-text">${escapeHtml(truncate(data.content, 120))}</div>`;
    } else if (data.files?.length) {
      preview = renderFileThumbnailHtml(data.files);
    }

    return `
      <div class="gallery-card" data-id="${escapeHtml(d.id)}" draggable="true">
        <div class="card-type-icon">${cfg.icon || ''}</div>
        <h3 class="card-title">${escapeHtml(data.title || '(제목 없음)')}</h3>
        ${preview}
        ${data.memo ? `<div class="card-memo">💬 ${escapeHtml(data.memo)}</div>` : ''}
        <div class="card-comment-count" data-sub-id="${escapeHtml(d.id)}"></div>
        <div class="card-footer">
          <span class="card-author">${escapeHtml(data.name)}</span>
          <span class="card-time">${time}${updated}</span>
        </div>
        <div class="card-actions">
          <button class="btn-icon btn-edit-sub" data-id="${escapeHtml(d.id)}" title="수정">✏️</button>
          <button class="btn-icon btn-icon-danger btn-del-sub" data-id="${escapeHtml(d.id)}" title="삭제">🗑</button>
        </div>
      </div>`;
  }).join('');
  loadCommentCounts(sorted.map(({ doc: d }) => d.id));
}

// Event delegation for teacher submissions
const submissionsList = document.getElementById('submissions-list');
submissionsList.addEventListener('click', (e) => {
  const editBtn = e.target.closest('.btn-edit-sub');
  if (editBtn) { e.stopPropagation(); teacherEditSubmission(editBtn.dataset.id); return; }

  const btn = e.target.closest('.btn-del-sub');
  if (btn) { e.stopPropagation(); removeSubmission(btn.dataset.id); return; }

  const card = e.target.closest('.gallery-card');
  if (card?.dataset.id) openDetail(card.dataset.id);
});

// ── Assignment Drag & Drop (Teacher) ──
let assignDragId = null;
let assignDragEl = null;

/** Find the card element closest below y (for drag insertion point).
 *  Works for both inquiry cards and submission cards via cardSelector. */
function getDragAfterElement(container, y, cardSelector = '.inquiry-card') {
  const cards = [...container.querySelectorAll(`${cardSelector}:not(.dragging)`)];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  cards.forEach(card => {
    const box = card.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = card;
    }
  });
  return closest;
}

/** Calculate sortOrder for insertion at afterEl position */
function calcDropSortOrder(container, afterEl, sortOrdersMap, cardSelector) {
  const cardEls = [...container.querySelectorAll(`${cardSelector}:not(.dragging)`)];
  if (cardEls.length === 0) return Date.now();
  if (!afterEl) {
    return (sortOrdersMap[cardEls.at(-1).dataset.id] || 0) - 1;
  }
  const idx = cardEls.indexOf(afterEl);
  const afterOrder = sortOrdersMap[afterEl.dataset.id] || 0;
  if (idx === 0) return afterOrder + 1;
  return ((sortOrdersMap[cardEls[idx - 1].dataset.id] || 0) + afterOrder) / 2;
}

async function assignDropCard(cardId, afterEl) {
  const sortOrder = calcDropSortOrder(submissionsList, afterEl, assignmentSortOrders, '.gallery-card');
  try {
    await updateDoc(doc(db, 'boards', currentBoardCode, 'submissions', cardId), { sortOrder });
  } catch (err) { console.error(err); toast('이동 실패'); }
}

submissionsList.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.gallery-card');
  if (!card) return;
  assignDragId = card.dataset.id;
  assignDragEl = card;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

submissionsList.addEventListener('dragend', () => {
  if (assignDragEl) assignDragEl.classList.remove('dragging');
  if (prevAssignHighlight) { prevAssignHighlight.classList.remove('drag-above'); prevAssignHighlight = null; }
  assignDragId = null;
  assignDragEl = null;
});

let prevAssignHighlight = null;
submissionsList.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const afterEl = getDragAfterElement(submissionsList, e.clientY, '.gallery-card');
  if (afterEl !== prevAssignHighlight) {
    if (prevAssignHighlight) prevAssignHighlight.classList.remove('drag-above');
    if (afterEl) afterEl.classList.add('drag-above');
    prevAssignHighlight = afterEl;
  }
});

submissionsList.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!assignDragId) return;
  const afterEl = getDragAfterElement(submissionsList, e.clientY, '.gallery-card');
  await assignDropCard(assignDragId, afterEl);
});

// Touch drag for assignment list
setupTouchDrag(submissionsList, {
  cardSelector: '.gallery-card',
  getDropTarget: (tx, ty) => {
    return { afterEl: getDragAfterElement(submissionsList, ty, '.gallery-card') };
  },
  onDrop: async (cardId, dropInfo, ty) => {
    const afterEl = getDragAfterElement(submissionsList, ty, '.gallery-card');
    await assignDropCard(cardId, afterEl);
  },
  highlightDrop: ({ afterEl }) => {
    if (afterEl) afterEl.classList.add('drag-above');
  },
  clearHighlight: () => {
    submissionsList.querySelectorAll('.gallery-card').forEach(c => c.classList.remove('drag-above'));
  },
});

async function teacherEditSubmission(submissionId) {
  try {
    const subDoc = await getDoc(doc(db, 'boards', currentBoardCode, 'submissions', submissionId));
    if (!subDoc.exists()) return;
    openEditModal(submissionId, subDoc.data(), true);
  } catch (e) { console.error(e); toast('수정 오류'); }
}

window.deleteBoard = async function() {
  if (!await showConfirm(`"${currentBoard.title}" 보드를 삭제하시겠습니까?`)) return;
  try {
    await deleteBoardData(currentBoardCode);
    toast('삭제됨');
    backToDashboard();
  } catch (e) { toast('삭제 실패'); }
};

// ── Edit Board ──
window.openEditBoardModal = function() {
  if (!currentBoard) return;
  document.getElementById('edit-board-title').value = currentBoard.title || '';
  document.getElementById('edit-board-desc').value = currentBoard.description || '';
  document.getElementById('edit-board-deadline').value = currentBoard.deadline || '';

  const isAssignment = currentBoard.type === 'assignment';
  document.getElementById('edit-assignment-options').style.display = isAssignment ? 'block' : 'none';
  if (isAssignment) {
    document.getElementById('edit-allow-url').checked = currentBoard.allowUrl !== false;
    document.getElementById('edit-allow-text').checked = currentBoard.allowText !== false;
    document.getElementById('edit-allow-file').checked = currentBoard.allowFile !== false;
  }

  document.getElementById('edit-board-modal').style.display = 'flex';
  openModalHistory();
};

window.closeEditBoardModal = function() { closeModal('edit-board-modal'); };

window.saveEditBoard = async function() {
  if (!currentBoard || !currentBoardCode) return;
  const title = document.getElementById('edit-board-title').value.trim();
  if (!title) { toast('제목을 입력하세요'); return; }

  const updateData = {
    title,
    description: document.getElementById('edit-board-desc').value.trim(),
    deadline: document.getElementById('edit-board-deadline').value || null,
  };

  if (currentBoard.type === 'assignment') {
    const allowUrl = document.getElementById('edit-allow-url').checked;
    const allowText = document.getElementById('edit-allow-text').checked;
    const allowFile = document.getElementById('edit-allow-file').checked;
    if (!allowUrl && !allowText && !allowFile) { toast('최소 하나의 제출 방식을 선택하세요'); return; }
    Object.assign(updateData, { allowUrl, allowText, allowFile });
  }

  try {
    await updateDoc(doc(db, 'boards', currentBoardCode), updateData);
    // Update local state
    Object.assign(currentBoard, updateData);

    // Update displayed title/desc
    if (currentBoard.type === 'inquiry') {
      document.getElementById('inquiry-board-title-display').textContent = title;
      setTextVisibility('inquiry-board-desc-display', updateData.description);
    } else if (currentBoard.type === 'classify') {
      document.getElementById('classify-board-title-display').textContent = title;
      setTextVisibility('classify-board-desc-display', updateData.description);
    } else {
      document.getElementById('board-title-display').textContent = title;
      setTextVisibility('board-desc-display', updateData.description);
    }

    // Update dashboard cache
    const idx = allBoards.findIndex(b => b.code === currentBoardCode);
    if (idx !== -1) {
      allBoards[idx].title = title;
      allBoards[idx].description = updateData.description;
      allBoards[idx].deadline = updateData.deadline;
    }

    closeModal('edit-board-modal');
    toast('보드가 수정되었습니다');
  } catch (e) { toast('수정 실패: ' + e.message); }
};

window.downloadAll = function() {
  const cards = submissionsList.querySelectorAll('.gallery-card');
  let text = `${currentBoard.title} - 제출물 목록\n${'='.repeat(50)}\n\n`;
  cards.forEach(card => {
    const name = card.querySelector('.card-author')?.textContent || '';
    const time = card.querySelector('.card-time')?.textContent || '';
    const icon = card.querySelector('.card-type-icon')?.textContent || '';
    const titleEl = card.querySelector('.card-title');
    const url = card.querySelector('.card-url');
    const textEl = card.querySelector('.card-text');
    const memo = card.querySelector('.card-memo');
    text += `이름: ${name}\n시간: ${time}\n유형: ${icon}\n`;
    if (titleEl) text += `제목: ${titleEl.textContent}\n`;
    if (url) text += `URL: ${url.textContent}\n`;
    if (textEl) text += `내용: ${textEl.textContent}\n`;
    if (memo) text += `메모: ${memo.textContent}\n`;
    text += `${'-'.repeat(50)}\n\n`;
  });
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${currentBoard.title}_제출물.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
};

// ══════════════════════════════════════
//  QR CODE POPUP WINDOW
// ══════════════════════════════════════
let qrPopup = null;

function openQrPopup(code, title) {
  const link = getJoinLink(code);
  if (qrPopup && !qrPopup.closed) qrPopup.close();
  qrPopup = window.open('', '_blank', 'width=400,height=520,menubar=no,toolbar=no,location=no,status=no');
  if (!qrPopup) { toast('팝업이 차단되었습니다. 팝업을 허용해주세요.'); return; }

  qrPopup.document.write(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<title>QR - ${escapeHtml(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"><\/script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f8fafc; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
  .title { font-size:1.2rem; font-weight:700; color:#1e293b; margin-bottom:16px; text-align:center; }
  #qr { margin-bottom:16px; }
  #qr canvas { border-radius:8px; }
  .link { font-size:.8rem; color:#64748b; word-break:break-all; text-align:center; margin-bottom:20px; max-width:320px; }
  .actions { display:flex; gap:10px; }
  .btn { padding:8px 18px; border:1px solid #e2e8f0; border-radius:8px; background:#fff; font-size:.85rem; font-weight:600; cursor:pointer; transition:all .15s; }
  .btn:hover { background:#eef2ff; border-color:#4f46e5; color:#4f46e5; }
</style></head><body>
<div class="title">${escapeHtml(title)}</div>
<div id="qr"></div>
<div class="link">${escapeHtml(link)}</div>
<div class="actions">
  <button class="btn" onclick="navigator.clipboard.writeText('${link}');this.textContent='복사됨!';setTimeout(()=>this.textContent='🔗 링크 복사',1500)">🔗 링크 복사</button>
  <button class="btn" onclick="var c=document.querySelector('#qr canvas');if(c){var a=document.createElement('a');a.href=c.toDataURL('image/png');a.download='QR_${escapeHtml(code)}.png';a.click()}">📥 QR 저장</button>
</div>
<script>new QRCode(document.getElementById('qr'),{text:'${link}',width:256,height:256,colorDark:'#1e293b',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});<\/script>
</body></html>`);
  qrPopup.document.close();
}

window.showQrModal = openQrPopup;
window.showBoardQr = function() {
  if (currentBoard) openQrPopup(currentBoard.code, currentBoard.title);
};

// ══════════════════════════════════════
//  INQUIRY: STUDENT GALLERY (Shelf)
// ══════════════════════════════════════
function showInquiryGallery() {
  document.getElementById('inquiry-gallery-title').textContent = currentBoard.title;
  setTextVisibility('inquiry-gallery-desc', currentBoard.description);
  document.getElementById('inquiry-gallery-student-name').textContent = studentName;

  showView('inquiry-gallery-view');
  location.hash = `inquiry/${currentBoardCode}`;

  if (unsubscribeInquiryGallery) unsubscribeInquiryGallery();
  let inquiryDocs = [];
  unsubscribeInquiryGallery = onSnapshot(
    query(collection(db, 'boards', currentBoardCode, 'submissions'), orderBy('createdAt', 'desc')),
    (snapshot) => { inquiryDocs = snapshot.docs; renderInquiryShelf(snapshot.docs, 'inquiry-gallery-shelf', false); }
  );

  // Board doc listener for real-time allowPeek sync
  if (unsubscribeBoardDoc) unsubscribeBoardDoc();
  unsubscribeBoardDoc = onSnapshot(doc(db, 'boards', currentBoardCode), (snap) => {
    if (snap.exists()) {
      const prev = currentBoard.allowPeek;
      currentBoard.allowPeek = snap.data().allowPeek;
      currentBoard.status = snap.data().status;
      if (prev !== currentBoard.allowPeek && inquiryDocs.length) renderInquiryShelf(inquiryDocs, 'inquiry-gallery-shelf', false);
    }
  });
}

function renderInquiryShelf(docs, containerId, isTeacher) {
  const container = document.getElementById(containerId);
  const categories = currentBoard.categories || Object.keys(INQUIRY_CATEGORIES);

  // 서로보기 차단 시 학생은 자기 질문만 표시
  if (!isTeacher && currentBoard?.allowPeek === false) {
    docs = docs.filter(d => d.data().deviceId === deviceId);
  }

  // Group by category
  const grouped = {};
  categories.forEach(cat => grouped[cat] = []);
  docs.forEach(d => {
    const data = d.data();
    const cat = data.category || 'factual';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ id: d.id, ...data });
  });

  // Sort within each category: by sortOrder (desc) then createdAt (desc)
  Object.values(grouped).forEach(items => {
    items.sort((a, b) => (b.sortOrder || 0) - (a.sortOrder || 0));
  });

  // Build sortOrder map for drag-drop position calculation
  if (isTeacher) {
    cardSortOrders = {};
    Object.values(grouped).forEach(items => {
      items.forEach(item => { cardSortOrders[item.id] = item.sortOrder || 0; });
    });
  }

  // Count display
  if (isTeacher) {
    document.getElementById('inquiry-submission-count').textContent = `총 ${docs.length}개 질문`;
  }

  container.innerHTML = categories.map(cat => {
    const cfg = INQUIRY_CATEGORIES[cat] || {};
    const items = grouped[cat] || [];
    return `
      <div class="shelf-column" data-category="${cat}">
        <div class="shelf-header" style="background:${cfg.color}">
          <span>${cfg.icon} ${cfg.label}</span>
          <span class="shelf-count">${items.length}</span>
        </div>
        <div class="shelf-cards">
          ${items.length === 0 ? '<div class="shelf-empty">아직 질문이 없습니다</div>' : items.map(item => {
            const isMine = item.deviceId === deviceId;
            const time = item.createdAt ? formatDateShort(item.createdAt.toDate()) : '';
            const liked = (item.likedBy || []).includes(deviceId);
            return `
              <div class="inquiry-card ${isMine ? 'inquiry-card-mine' : ''}" data-id="${escapeHtml(item.id)}" data-device="${escapeHtml(item.deviceId || '')}" ${isTeacher || (isMine && STUDENT_CATEGORIES.includes(cat)) ? `draggable="true"` : ''}>
                <div class="inquiry-card-content">${escapeHtml(item.content)}</div>
                <div class="inquiry-card-footer">
                  <span class="inquiry-card-author">${escapeHtml(item.name)}</span>
                  <span class="inquiry-card-time">${time}</span>
                </div>
                <div class="inquiry-card-actions">
                  <button class="like-btn ${liked ? 'liked' : ''}" data-id="${escapeHtml(item.id)}">
                    ${liked ? '❤️' : '🤍'} <span class="like-count">${item.likes || 0}</span>
                  </button>
                  ${isTeacher ? `
                    <button class="btn-icon btn-icon-danger btn-del-inquiry" data-id="${escapeHtml(item.id)}" title="삭제">🗑</button>
                  ` : isMine ? `<button class="btn-icon btn-icon-danger btn-del-inquiry" data-id="${escapeHtml(item.id)}" title="삭제">🗑</button>` : ''}
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');
}

// Event delegation for inquiry gallery shelf
const studentShelf = document.getElementById('inquiry-gallery-shelf');
studentShelf.addEventListener('click', (e) => {
  const likeBtn = e.target.closest('.like-btn');
  if (likeBtn) { toggleLike(currentBoardCode, likeBtn.dataset.id); return; }

  const delBtn = e.target.closest('.btn-del-inquiry');
  if (delBtn) { removeSubmission(delBtn.dataset.id, { checkOwnership: true }); return; }
});

// ── Student Drag & Drop (own cards, category change only) ──
let studentDragId = null;
let studentDragEl = null;

studentShelf.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.inquiry-card');
  const srcCat = card?.closest('.shelf-column')?.dataset.category;
  if (!card || card.dataset.device !== deviceId || !STUDENT_CATEGORIES.includes(srcCat)) { e.preventDefault(); return; }
  studentDragId = card.dataset.id;
  studentDragEl = card;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

studentShelf.addEventListener('dragend', () => {
  if (studentDragEl) studentDragEl.classList.remove('dragging');
  if (prevStudentCol) { prevStudentCol.classList.remove('shelf-drop-target'); prevStudentCol = null; }
  studentDragId = null;
  studentDragEl = null;
});

let prevStudentCol = null;
studentShelf.addEventListener('dragover', (e) => {
  if (!studentDragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const col = e.target.closest('.shelf-column');
  if (col && STUDENT_CATEGORIES.includes(col.dataset.category)) {
    if (col !== prevStudentCol) {
      if (prevStudentCol) prevStudentCol.classList.remove('shelf-drop-target');
      col.classList.add('shelf-drop-target');
      prevStudentCol = col;
    }
  }
});

studentShelf.addEventListener('dragleave', (e) => {
  const col = e.target.closest('.shelf-column');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('shelf-drop-target');
});

studentShelf.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!studentDragId) return;
  const col = e.target.closest('.shelf-column');
  if (!col) return;
  const newCat = col.dataset.category;
  if (!STUDENT_CATEGORIES.includes(newCat)) { toast('이 카테고리로 이동할 수 없습니다'); return; }
  try {
    await updateDoc(doc(db, 'boards', currentBoardCode, 'submissions', studentDragId), { category: newCat });
  } catch (err) { console.error(err); toast('이동 실패'); }
});

// Touch drag for student shelf (own cards only)
setupTouchDrag(studentShelf, {
  cardSelector: '.inquiry-card',
  canDrag: (card) => card.dataset.device === deviceId && STUDENT_CATEGORIES.includes(card.closest('.shelf-column')?.dataset.category),
  getDropTarget: (tx, ty) => {
    const col = document.elementFromPoint(tx, ty)?.closest('.shelf-column');
    if (!col || !STUDENT_CATEGORIES.includes(col.dataset.category)) return null;
    return { col };
  },
  onDrop: async (cardId, { col }) => {
    // Verify ownership
    const card = studentShelf.querySelector(`.inquiry-card[data-id="${cardId}"]`);
    if (!card || card.dataset.device !== deviceId) return;
    try {
      await updateDoc(doc(db, 'boards', currentBoardCode, 'submissions', cardId), { category: col.dataset.category });
    } catch (err) { console.error(err); toast('이동 실패'); }
  },
  highlightDrop: ({ col }) => { col.classList.add('shelf-drop-target'); },
  clearHighlight: () => {
    studentShelf.querySelectorAll('.shelf-column').forEach(c => c.classList.remove('shelf-drop-target'));
  },
});

// Event delegation for inquiry board shelf (teacher)
document.getElementById('inquiry-board-shelf').addEventListener('click', (e) => {
  const likeBtn = e.target.closest('.like-btn');
  if (likeBtn) { e.stopPropagation(); return; }

  const delBtn = e.target.closest('.btn-del-inquiry');
  if (delBtn) { removeSubmission(delBtn.dataset.id); return; }
});

// ── Drag & Drop (Teacher Board) ──
const teacherShelf = document.getElementById('inquiry-board-shelf');
let draggedId = null;
let draggedEl = null;

teacherShelf.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.inquiry-card');
  if (!card) return;
  draggedId = card.dataset.id;
  draggedEl = card;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

teacherShelf.addEventListener('dragend', (e) => {
  if (draggedEl) draggedEl.classList.remove('dragging');
  if (prevTeacherCol) { prevTeacherCol.classList.remove('shelf-drop-target'); prevTeacherCol = null; }
  if (prevTeacherCard) { prevTeacherCard.classList.remove('drag-above'); prevTeacherCard = null; }
  draggedId = null;
  draggedEl = null;
});

let prevTeacherCol = null;
let prevTeacherCard = null;
teacherShelf.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const col = e.target.closest('.shelf-column');
  if (col !== prevTeacherCol) {
    if (prevTeacherCol) prevTeacherCol.classList.remove('shelf-drop-target');
    if (col) col.classList.add('shelf-drop-target');
    prevTeacherCol = col;
  }
  const cardsContainer = e.target.closest('.shelf-cards');
  if (cardsContainer) {
    const closest = getDragAfterElement(cardsContainer, e.clientY);
    if (closest !== prevTeacherCard) {
      if (prevTeacherCard) prevTeacherCard.classList.remove('drag-above');
      if (closest) closest.classList.add('drag-above');
      prevTeacherCard = closest;
    }
  }
});

teacherShelf.addEventListener('dragleave', (e) => {
  const col = e.target.closest('.shelf-column');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('shelf-drop-target');
});

teacherShelf.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!draggedId) return;
  const col = e.target.closest('.shelf-column');
  if (!col) return;
  await inquiryDropCard(draggedId, col, e.clientY);
});

// Track sort orders for inquiry drop position calculation
let cardSortOrders = {};

/** Shared drop logic for inquiry shelf (mouse + touch) */
async function inquiryDropCard(cardId, col, clientY) {
  const newCategory = col.dataset.category;
  const cardsContainer = col.querySelector('.shelf-cards');
  const afterEl = getDragAfterElement(cardsContainer, clientY);
  const sortOrder = calcDropSortOrder(cardsContainer, afterEl, cardSortOrders, '.inquiry-card');
  try {
    await updateDoc(doc(db, 'boards', currentBoardCode, 'submissions', cardId), {
      category: newCategory,
      sortOrder
    });
  } catch (err) { console.error(err); toast('이동 실패'); }
}

// Touch drag for inquiry shelf
setupTouchDrag(teacherShelf, {
  cardSelector: '.inquiry-card',
  getDropTarget: (tx, ty) => {
    const col = document.elementFromPoint(tx, ty)?.closest('.shelf-column');
    if (!col) return null;
    const afterEl = getDragAfterElement(col.querySelector('.shelf-cards'), ty);
    return { col, afterEl };
  },
  onDrop: async (cardId, { col }, ty) => {
    await inquiryDropCard(cardId, col, ty);
  },
  highlightDrop: ({ col, afterEl }) => {
    col.classList.add('shelf-drop-target');
    if (afterEl) afterEl.classList.add('drag-above');
  },
  clearHighlight: () => {
    teacherShelf.querySelectorAll('.shelf-column').forEach(c => c.classList.remove('shelf-drop-target'));
    teacherShelf.querySelectorAll('.inquiry-card').forEach(c => c.classList.remove('drag-above'));
  },
});

// ── Like Toggle ──
async function toggleLike(boardCode, submissionId) {
  const subRef = doc(db, 'boards', boardCode, 'submissions', submissionId);
  try {
    const subDoc = await getDoc(subRef);
    if (!subDoc.exists()) return;
    const data = subDoc.data();
    const likedBy = data.likedBy || [];
    const isLiked = likedBy.includes(deviceId);
    await updateDoc(subRef, {
      likes: isLiked ? Math.max((data.likes || 1) - 1, 0) : (data.likes || 0) + 1,
      likedBy: isLiked ? likedBy.filter(id => id !== deviceId) : [...likedBy, deviceId]
    });
  } catch (e) { console.error(e); toast('오류 발생'); }
}

// ── Category Change (Teacher) ──
async function changeCategory(boardCode, submissionId, newCategory) {
  try {
    await updateDoc(doc(db, 'boards', boardCode, 'submissions', submissionId), { category: newCategory });
    toast('카테고리 변경됨');
  } catch (e) { console.error(e); toast('변경 실패'); }
}

// ── Inquiry Submit Modal ──
window.openInquirySubmitForm = function() {
  const selectContainer = document.getElementById('inquiry-category-select');
  selectContainer.innerHTML = STUDENT_CATEGORIES.map((cat, i) => {
    const cfg = INQUIRY_CATEGORIES[cat];
    return `<button class="cat-select-btn ${i === 0 ? 'active' : ''}" data-cat="${cat}" style="background:${cfg.color}" onclick="selectInquiryCategory('${cat}')">${cfg.icon} ${cfg.label}</button>`;
  }).join('');
  window._selectedInquiryCategory = STUDENT_CATEGORIES[0];
  document.getElementById('inquiry-question-input').value = '';
  document.getElementById('inquiry-submit-modal').style.display = 'flex';
  openModalHistory();
  setTimeout(() => document.getElementById('inquiry-question-input').focus(), 100);
};

window.selectInquiryCategory = function(cat) {
  window._selectedInquiryCategory = cat;
  document.querySelectorAll('.cat-select-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
};

window.closeInquirySubmitModal = function() { closeModal('inquiry-submit-modal'); };

window.openCategoryGuideModal = function() {
  const GUIDE = {
    factual: { desc: '관찰하거나 조사하면 답을 찾을 수 있는 질문이에요.', ex: '"빛은 어떤 물질을 통과할 수 있을까?"' },
    conceptual: { desc: '개념이나 원리를 이해하기 위한 질문이에요.', ex: '"빛이 꺾이는 이유는 무엇일까?"' },
    debatable: { desc: '서로 다른 의견이 있을 수 있는 질문이에요.', ex: '"빛은 파동일까, 입자일까?"' },
  };
  const body = document.getElementById('category-guide-body');
  body.innerHTML = STUDENT_CATEGORIES.map(cat => {
    const cfg = INQUIRY_CATEGORIES[cat];
    const g = GUIDE[cat] || {};
    return `<div style="background:${cfg.color};border-radius:12px;padding:14px 16px;margin-bottom:10px">
      <div style="font-size:1.1rem;font-weight:700;margin-bottom:4px">${cfg.icon} ${cfg.label}</div>
      <div style="font-size:.9rem;color:#334155;margin-bottom:6px">${g.desc || ''}</div>
      <div style="font-size:.85rem;color:#64748b;font-style:italic">예) ${g.ex || ''}</div>
    </div>`;
  }).join('');
  document.getElementById('category-guide-modal').style.display = 'flex';
  openModalHistory();
};

window.closeCategoryGuideModal = function() { closeModal('category-guide-modal'); };

window.submitInquiry = async function() {
  const content = document.getElementById('inquiry-question-input').value.trim();
  if (!content) { toast('질문 내용을 입력하세요'); return; }

  const btn = document.getElementById('inquiry-submit-btn');
  btn.disabled = true;
  btn.textContent = '올리는 중...';

  try {
    const submissionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await setDoc(doc(db, 'boards', currentBoardCode, 'submissions', submissionId), {
      name: studentName,
      content,
      category: window._selectedInquiryCategory || 'factual',
      likes: 0,
      likedBy: [],
      deviceId,
      boardCode: currentBoardCode,
      createdAt: serverTimestamp()
    });
    toast('질문이 등록되었습니다!');
    closeInquirySubmitModal();
  } catch (e) {
    console.error(e);
    toast('오류: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '질문 올리기';
  }
};

// ══════════════════════════════════════
//  INQUIRY: TEACHER BOARD VIEW
// ══════════════════════════════════════
function showInquiryBoard(code) {
  document.getElementById('inquiry-board-title-display').textContent = currentBoard.title;
  document.getElementById('inquiry-board-code-badge').textContent = `코드: ${code}`;
  setTextVisibility('inquiry-board-desc-display', currentBoard.description);
  updatePeekToggleBtn('inquiry-peek-toggle');

  showView('inquiry-board-view');
  location.hash = `board/${code}`;

  if (unsubscribeInquiryBoard) unsubscribeInquiryBoard();
  unsubscribeInquiryBoard = onSnapshot(
    query(collection(db, 'boards', code, 'submissions'), orderBy('createdAt', 'desc')),
    (snap) => renderInquiryShelf(snap.docs, 'inquiry-board-shelf', true)
  );
}

// ══════════════════════════════════════
//  CLASSIFY: TREE + FOLDER VIEW (마인드맵 사전)
// ══════════════════════════════════════
const CL_COLORS = ['#4A90D9', '#27AE60', '#E67E22', '#E74C3C', '#9B59B6', '#1ABC9C', '#F1C40F', '#34495E', '#E91E63', '#00BCD4'];

const CL = {
  allCards: [], cards: [], tree: [], cardMap: {},
  currentView: 'tree', currentPage: 'overview',
  workspaceId: '',
  searchQuery: '', folderParentId: '', bookPage: 0,
  editingCardId: null, addParentId: null, addType: null,
  contextCardId: null, dragCardId: null,
  isTeacher: false,
  // Editor state (replaces window._ globals)
  editorImageUrl: '', editorImagePath: '', editorNewFile: null,
  addPopupParentId: undefined, moveCardId: null,
  modalClosing: false,
  boardUnsub: null, // board doc listener for member updates
};

// ── Classify Sub-Routing ──
/** Build classify hash from current CL state */
function clBuildHash(isTeacher) {
  const prefix = isTeacher ? `board/${currentBoardCode}` : `classify/${currentBoardCode}`;
  if (CL.currentPage !== 'workspace' || !CL.workspaceId) return prefix;
  let h = `${prefix}/ws/${CL.workspaceId}`;
  if (CL.currentView === 'folder') {
    h += '/folder';
    if (CL.folderParentId) h += `/${CL.folderParentId}`;
  } else if (CL.currentView === 'book') {
    h += '/book';
  }
  return h;
}

/** Parse classify sub-route from hash. Returns null if not a classify sub-route. */
function clParseSubRoute(hash) {
  // Student: classify/CODE[/ws/WSID[/(folder[/PARENTID]|book)]]
  // Teacher: board/CODE[/ws/WSID[/(folder[/PARENTID]|book)]]
  const m = hash.match(/^(classify|board)\/([A-Z0-9]+)(\/ws\/([^/]+)(\/(folder(\/(.+))?|book))?)?$/);
  if (!m) return null;
  const viewSegment = m[6] || ''; // 'folder', 'folder/ID', or 'book'
  return {
    type: m[1], // 'classify' or 'board'
    code: m[2],
    wsId: m[4] || '',
    view: viewSegment === 'book' ? 'book' : (m[5] ? 'folder' : (m[4] ? 'tree' : '')),
    folderId: m[8] || '',
  };
}

/** Navigate CL state from parsed sub-route without re-subscribing */
function clApplySubRoute(parsed, containerId) {
  if (!parsed.wsId) {
    // Overview
    CL.currentPage = 'overview';
    CL.workspaceId = '';
  } else {
    // Workspace
    CL.currentPage = 'workspace';
    CL.workspaceId = parsed.wsId;
    CL.currentView = parsed.view || 'tree';
    CL.folderParentId = parsed.folderId || '';
  }
  CL.searchQuery = '';
  const isBoard = containerId === 'cl-board-container';
  const searchInput = document.getElementById(isBoard ? 'cl-search-board' : 'cl-search-gallery');
  if (searchInput) searchInput.value = '';
  // Update view toggle buttons
  const parent = document.getElementById(containerId)?.closest('.view');
  if (parent) {
    parent.querySelectorAll('.cl-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === CL.currentView));
  }
  clBuildTree();
  clRenderCurrentView(containerId);
}

/** Check if current workspace belongs to the current user */
function clIsMyWorkspace() {
  if (CL.isTeacher) return true; // teacher can edit anything
  if (!CL.workspaceId) return false;
  const settings = currentBoard?.settings || {};
  if (settings.groupMode === 'team') {
    const savedGroupId = localStorage.getItem(`easyup_group_${currentBoardCode}`);
    return CL.workspaceId === savedGroupId;
  }
  return CL.workspaceId === deviceId;
}

function clSubsRef() {
  return collection(db, 'boards', currentBoardCode, 'submissions');
}

/** Get editable workspace title (falls back to board title) */
function clGetWsTitle() {
  if (!CL.workspaceId) return currentBoard?.title || '';
  const settings = currentBoard?.settings || {};
  if (settings.groupMode === 'team') {
    return currentBoard?.groups?.[CL.workspaceId]?.wsTitle || currentBoard?.title || '';
  }
  return currentBoard?.members?.[CL.workspaceId]?.wsTitle || currentBoard?.title || '';
}

/** Build tree from flat card list */
function clBuildTree() {
  CL.cardMap = {};
  CL.allCards.forEach(c => { CL.cardMap[c.id] = c; });

  // Filter by workspace
  let wsFiltered = CL.allCards;
  if (CL.currentPage === 'workspace' && CL.workspaceId) {
    wsFiltered = wsFiltered.filter(c => c.workspaceId === CL.workspaceId);
  }

  // Filter by search
  let filtered = wsFiltered;
  if (CL.searchQuery) {
    const q = CL.searchQuery.toLowerCase();
    const matched = wsFiltered.filter(c =>
      (c.title || '').toLowerCase().includes(q) ||
      (c.content || '').toLowerCase().includes(q)
    );
    // Include ancestors of matched cards
    const ids = new Set(matched.map(c => c.id));
    matched.forEach(c => {
      let pid = c.parentId;
      while (pid && CL.cardMap[pid]) {
        ids.add(pid);
        pid = CL.cardMap[pid].parentId;
      }
    });
    filtered = wsFiltered.filter(c => ids.has(c.id));
  }
  CL.cards = filtered;

  // Group by parentId
  const children = {};
  filtered.forEach(c => {
    const pid = c.parentId || '';
    if (!children[pid]) children[pid] = [];
    children[pid].push(c);
  });
  // Sort children by order
  Object.values(children).forEach(arr => arr.sort((a, b) => (a.order || 0) - (b.order || 0)));

  function build(parentId) {
    return (children[parentId] || []).map(c => ({
      ...c,
      children: build(c.id)
    }));
  }
  CL.tree = build('');
}

/** Render current view (overview, tree, or folder) */
function clRenderCurrentView(containerId) {
  clUpdateToolbarVisibility(containerId);
  if (CL.currentPage === 'overview') {
    clRenderOverview(containerId);
  } else if (CL.currentView === 'folder') {
    clRenderFolderView(containerId);
  } else if (CL.currentView === 'book') {
    // If overlay already open, just refresh its content
    if (document.getElementById('cl-book-overlay')) {
      CL.bookPages = clBuildBookPages();
      clBookGoTo(CL.bookPage || 0);
    } else {
      clRenderBookView(containerId);
    }
  } else {
    clRenderTreeView(containerId);
  }
}

/** Show/hide toolbar elements based on current page */
function clUpdateToolbarVisibility(containerId) {
  const isBoard = containerId === 'cl-board-container';
  const prefix = isBoard ? 'cl-board' : 'cl-gallery';
  const backBtn = document.getElementById(`${prefix}-back-btn`);
  const viewToggle = document.getElementById(`${prefix}-view-toggle`);
  const searchBox = document.getElementById(`${prefix}-search-box`);
  const inWorkspace = CL.currentPage === 'workspace';
  if (backBtn) backBtn.style.display = inWorkspace ? '' : 'none';
  if (viewToggle) viewToggle.style.display = inWorkspace ? '' : 'none';
  if (searchBox) searchBox.style.display = inWorkspace ? '' : 'none';
  // Reset add popup
  const addPopup = document.getElementById(`${prefix}-add-popup`);
  if (addPopup) addPopup.style.display = 'none';
  // Dynamic FAB: only in folder view workspace
  const view = document.getElementById(containerId)?.closest('.view');
  if (view) {
    let fab = view.querySelector('.cl-fab');
    const showFab = inWorkspace && CL.currentView === 'folder' && clIsMyWorkspace() && (!isBoardClosed() || CL.isTeacher);
    if (showFab) {
      if (!fab) {
        fab = document.createElement('button');
        fab.className = 'cl-fab';
        fab.textContent = '+';
        fab.onclick = () => clOpenAddPopup(containerId);
        view.appendChild(fab);
      }
      fab.style.display = '';
    } else if (fab) {
      fab.style.display = 'none';
    }
  }
}

/** Pre-compute entry counts per workspace */
function clGetCardCountMap() {
  const map = {};
  CL.allCards.forEach(c => {
    if (c.cardType !== 'category' && c.workspaceId) {
      map[c.workspaceId] = (map[c.workspaceId] || 0) + 1;
    }
  });
  return map;
}

/** Get my groupId from board.members or localStorage fallback */
function clGetMyGroupId() {
  const members = currentBoard?.members || {};
  const me = members[deviceId];
  if (me?.groupId) return me.groupId;
  // Fallback: check localStorage (set during name entry)
  const saved = localStorage.getItem(`easyup_group_${currentBoardCode}`);
  if (saved) return saved;
  // Fallback: find from submissions
  const myCard = CL.allCards.find(c => c.deviceId === deviceId && c.workspaceId);
  return myCard?.workspaceId || '';
}

/** Render overview page (list of workspaces) */
function clRenderOverview(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const settings = currentBoard?.settings || {};
  const mode = settings.groupMode || 'individual';
  const members = { ...(currentBoard?.members || {}) };

  // Supplement members from submissions (catch students who bypassed normal entry)
  CL.allCards.forEach(card => {
    if (card.deviceId && card.name && !members[card.deviceId]) {
      const memberData = { name: card.name };
      if (mode === 'team' && card.workspaceId) memberData.groupId = card.workspaceId;
      members[card.deviceId] = memberData;
    }
  });
  const memberEntries = Object.entries(members);

  // Update member count badge
  const memberCountEl = document.getElementById(CL.isTeacher ? 'classify-board-member-count' : 'classify-gallery-member-count');
  if (memberCountEl) memberCountEl.textContent = `👥 ${memberEntries.length}명`;

  const allowPeek = currentBoard?.allowPeek !== false;
  const canSeeAll = CL.isTeacher || allowPeek;
  const cardCountMap = clGetCardCountMap();
  let html = '';

  if (mode === 'team') {
    const groups = currentBoard?.groups || {};
    let groupEntries = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
    if (!canSeeAll) {
      const myGroupId = clGetMyGroupId();
      groupEntries = groupEntries.filter(([gId]) => gId === myGroupId);
    }
    if (groupEntries.length === 0) {
      html = '<div class="empty-state" style="padding:40px"><p>모둠이 없습니다.</p></div>';
    } else {
      html = '<div class="cl-overview-grid">';
      groupEntries.forEach(([gId, g]) => {
        const gMembers = memberEntries.filter(([, m]) => m.groupId === gId);
        const cardCount = cardCountMap[gId] || 0;
        const color = g.color || '#4A90D9';
        const memberNames = gMembers.map(([, m]) => escapeHtml(m.name)).join(', ') || '아직 없음';
        html += `
          <div class="cl-overview-card" data-ws-id="${escapeHtml(gId)}" style="border-color:${color}">
            <div class="cl-overview-icon">👥</div>
            <div class="cl-overview-name" style="color:${color}">${escapeHtml(g.name)}</div>
            <div class="cl-overview-sub">${cardCount}개 항목</div>
            <div class="cl-overview-members">${memberNames}</div>
          </div>`;
      });
      html += '</div>';
    }
  } else {
    // Individual mode
    let visibleMembers = memberEntries;
    if (!canSeeAll) {
      visibleMembers = memberEntries.filter(([dId]) => dId === deviceId);
    }
    if (visibleMembers.length === 0) {
      html = '<div class="empty-state" style="padding:40px"><div class="empty-state-icon">👤</div><p>아직 참여한 학생이 없습니다.</p></div>';
    } else {
      html = '<div class="cl-overview-grid">';
      visibleMembers.forEach(([dId, m]) => {
        const cardCount = cardCountMap[dId] || 0;
        html += `
          <div class="cl-overview-card" data-ws-id="${escapeHtml(dId)}">
            <div class="cl-overview-icon">👤</div>
            <div class="cl-overview-name">${escapeHtml(m.name)}</div>
            <div class="cl-overview-sub">${cardCount}개 항목</div>
          </div>`;
      });
      html += '</div>';
    }
  }

  container.innerHTML = html;
}

/** Enter a specific workspace from overview */
window.clEnterWorkspace = function(wsId, containerId) {
  // Block peek if disabled (student can only access own workspace)
  if (!CL.isTeacher && currentBoard?.allowPeek === false) {
    const settings = currentBoard?.settings || {};
    if (settings.groupMode === 'team') {
      if (wsId !== clGetMyGroupId()) { toast('다른 모둠은 볼 수 없습니다.'); return; }
    } else {
      if (wsId !== deviceId) { toast('다른 학생의 사전은 볼 수 없습니다.'); return; }
    }
  }
  CL.workspaceId = wsId;
  CL.currentPage = 'workspace';
  CL.currentView = 'tree';
  CL.folderParentId = '';
  CL.searchQuery = '';
  const isBoard = containerId === 'cl-board-container';
  const searchInput = document.getElementById(isBoard ? 'cl-search-board' : 'cl-search-gallery');
  if (searchInput) searchInput.value = '';
  clBuildTree();
  clRenderCurrentView(containerId);
  location.hash = clBuildHash(isBoard);
};

/** Go back to overview from workspace */
window.clBackToOverview = function(containerId) {
  CL.currentPage = 'overview';
  CL.workspaceId = '';
  CL.searchQuery = '';
  const isBoard = containerId === 'cl-board-container';
  clBuildTree();
  clRenderCurrentView(containerId);
  location.hash = clBuildHash(isBoard);
};

/** Copy join code (student view) */
window.clCopyJoinCode = function() {
  if (currentBoardCode) {
    navigator.clipboard.writeText(currentBoardCode);
    toast('코드 복사됨');
  }
};

/** Populate group dropdown (called on gallery load and member updates) */
function clPopulateGroupSelect() {
  const select = document.getElementById('cl-group-select');
  if (!select) return;
  const settings = currentBoard?.settings || {};
  // Hide if not team mode, or if peek is disabled (can't change group)
  if (settings.groupMode !== 'team' || currentBoard?.allowPeek === false) { select.style.display = 'none'; return; }

  const groups = currentBoard?.groups || {};
  const members = currentBoard?.members || {};
  const currentGroupId = localStorage.getItem(`easyup_group_${currentBoardCode}`) || '';

  select.innerHTML = Object.entries(groups)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([gId, g]) => {
      const gMembers = Object.entries(members).filter(([, m]) => m.groupId === gId).map(([, m]) => m.name);
      const memberStr = gMembers.length > 0 ? ` (${gMembers.join(', ')})` : '';
      return `<option value="${gId}" ${gId === currentGroupId ? 'selected' : ''}>${g.name}${memberStr}</option>`;
    }).join('');
  select.style.display = '';
}

/** Handle group dropdown change */
window.clOnGroupChange = async function(newGroupId) {
  if (!newGroupId) return;
  const groups = currentBoard?.groups || {};
  localStorage.setItem(`easyup_group_${currentBoardCode}`, newGroupId);
  try {
    await updateDoc(doc(db, 'boards', currentBoardCode), {
      [`members.${deviceId}`]: { name: studentName, groupId: newGroupId }
    });
    toast(`${groups[newGroupId]?.name || newGroupId}으로 변경됨`);
    // Update name badge with new group
    const nameEl = document.getElementById('classify-gallery-student-name');
    if (nameEl) nameEl.textContent = `${studentName} (${groups[newGroupId]?.name || ''})`;
    CL.currentPage = 'overview';
    CL.workspaceId = '';
    clBuildTree();
    clRenderCurrentView('cl-gallery-container');
  } catch (e) { toast('변경 실패'); }
};

/** Subscribe to classify data and render */
function clSubscribe(containerId, isTeacher) {
  CL.isTeacher = isTeacher;
  // Subscribe to submissions
  const unsubCards = onSnapshot(
    query(clSubsRef(), orderBy('createdAt', 'asc')),
    (snap) => {
      CL.allCards = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      clBuildTree();
      clRenderCurrentView(containerId);
      // Update count
      const cats = CL.allCards.filter(c => c.cardType === 'category').length;
      const entries = CL.allCards.filter(c => c.cardType === 'entry').length;
      const countEl = document.getElementById(isTeacher ? 'classify-submission-count' : 'classify-gallery-count');
      if (countEl) countEl.textContent = `${cats}개 분류 · ${entries}개 항목`;
    }
  );
  // Subscribe to board doc for member updates
  if (CL.boardUnsub) CL.boardUnsub();
  CL.boardUnsub = onSnapshot(doc(db, 'boards', currentBoardCode), (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      currentBoard.members = data.members || {};
      currentBoard.groups = data.groups || {};
      currentBoard.settings = data.settings || {};
      currentBoard.allowPeek = data.allowPeek;
      if (isTeacher) clUpdatePeekButton();
      // Re-render current view to reflect member/group/wsTitle changes
      if (CL.currentPage === 'overview') {
        clRenderOverview(containerId);
      } else {
        clRenderCurrentView(containerId);
      }
      // Refresh group dropdown on member changes
      if (!isTeacher) {
        clPopulateGroupSelect();
        // Sync student name if teacher changed it
        const myMember = currentBoard.members[deviceId];
        if (myMember && myMember.name && myMember.name !== studentName) {
          studentName = myMember.name;
          localStorage.setItem(`easyup_name_${currentBoardCode}`, studentName);
          const nameEl = document.getElementById('classify-gallery-student-name');
          if (nameEl) {
            const groupName = myMember.groupId && currentBoard.groups?.[myMember.groupId]?.name;
            nameEl.textContent = groupName ? `${studentName} (${groupName})` : studentName;
          }
        }
      }
    }
  });
  return () => { unsubCards(); if (CL.boardUnsub) { CL.boardUnsub(); CL.boardUnsub = null; } };
}

// ── Student Gallery ──
async function showClassifyGallery() {
  document.getElementById('classify-gallery-title').textContent = currentBoard.title;
  setTextVisibility('classify-gallery-desc', currentBoard.description);
  // Show student name with group if team mode
  const nameEl = document.getElementById('classify-gallery-student-name');
  if (currentBoard?.settings?.groupMode === 'team') {
    const savedGroupId = localStorage.getItem(`easyup_group_${currentBoardCode}`);
    const groupName = savedGroupId && currentBoard.groups?.[savedGroupId]?.name;
    nameEl.textContent = groupName ? `${studentName} (${groupName})` : studentName;
  } else {
    nameEl.textContent = studentName;
  }

  // Show join code
  const joinCodeEl = document.getElementById('classify-gallery-join-code');
  if (joinCodeEl) joinCodeEl.textContent = `코드: ${currentBoardCode}`;

  // Parse initial sub-route from hash (for direct URL access / refresh)
  const initParsed = clParseSubRoute(location.hash.slice(1));
  CL.currentView = initParsed?.view || 'tree';
  CL.currentPage = initParsed?.wsId ? 'workspace' : 'overview';
  CL.workspaceId = initParsed?.wsId || '';
  CL.searchQuery = '';
  CL.folderParentId = initParsed?.folderId || '';
  const searchInput = document.getElementById('cl-search-gallery');
  if (searchInput) searchInput.value = '';

  // Register as member in board
  try {
    const memberData = { name: studentName };
    const settings = currentBoard?.settings || {};
    if (settings.groupMode === 'team') {
      const savedGroupId = localStorage.getItem(`easyup_group_${currentBoardCode}`);
      if (savedGroupId) memberData.groupId = savedGroupId;
    }
    await updateDoc(doc(db, 'boards', currentBoardCode), {
      [`members.${deviceId}`]: memberData
    });
  } catch (e) { console.error('Member registration failed:', e); }

  // Populate group dropdown (team mode)
  clPopulateGroupSelect();

  showView('classify-gallery-view');
  location.hash = `classify/${currentBoardCode}`;

  if (unsubscribeClassifyGallery) unsubscribeClassifyGallery();
  unsubscribeClassifyGallery = clSubscribe('cl-gallery-container', false);
}

// ── Teacher Board View ──
function showClassifyBoard(code) {
  document.getElementById('classify-board-title-display').textContent = currentBoard.title;
  document.getElementById('classify-board-code-badge').textContent = `코드: ${code}`;
  setTextVisibility('classify-board-desc-display', currentBoard.description);
  clUpdatePeekButton();

  // Parse initial sub-route from hash
  const initParsed = clParseSubRoute(location.hash.slice(1));
  CL.currentView = initParsed?.view || 'tree';
  CL.currentPage = initParsed?.wsId ? 'workspace' : 'overview';
  CL.workspaceId = initParsed?.wsId || '';
  CL.searchQuery = '';
  CL.folderParentId = initParsed?.folderId || '';
  const searchInput = document.getElementById('cl-search-board');
  if (searchInput) searchInput.value = '';

  showView('classify-board-view');

  if (unsubscribeClassifyBoard) unsubscribeClassifyBoard();
  unsubscribeClassifyBoard = clSubscribe('cl-board-container', true);
}

// ── View Toggle ──
window.clSwitchView = function(view, containerId) {
  CL.currentView = view;
  if (view === 'folder') CL.folderParentId = '';
  if (view === 'book') CL.bookPage = 0;
  const parent = document.getElementById(containerId)?.closest('.view');
  if (parent) {
    parent.querySelectorAll('.cl-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  }
  const isBoard = containerId === 'cl-board-container';
  clBuildTree();
  clRenderCurrentView(containerId);
  location.hash = clBuildHash(isBoard);
};

// ── Search ──
window.clSearch = function(value, containerId) {
  CL.searchQuery = value;
  clBuildTree();
  clRenderCurrentView(containerId);
};

// ══════════════════════════════════════
//  CLASSIFY: TREE VIEW
// ══════════════════════════════════════
function clRenderTreeView(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const isTeacher = CL.isTeacher;
  const canAdd = clIsMyWorkspace() && (!isBoardClosed() || isTeacher);

  // Root node: workspace custom title or board title
  const rootTitle = clGetWsTitle();
  const totalCount = CL.cards.filter(c => c.cardType !== 'category').length;
  const canEditTitle = clIsMyWorkspace() && (!isBoardClosed() || isTeacher);

  let html = '<div class="cl-tree-canvas"><div class="cl-tree-root">';
  // Root node
  html += `<div class="cl-tree-node" data-id="__root__">
    <div class="cl-node-box cl-root-node" data-card-id="__root__">
      <div class="cl-node-header">
        <span class="cl-node-title">${escapeHtml(rootTitle)}</span>
        ${canEditTitle ? `<button class="cl-root-edit-btn" title="제목 변경">✏️</button>` : ''}
      </div>
      <div class="cl-node-meta"><span class="cl-node-badge">${totalCount}개 항목</span></div>
      ${canAdd ? `<button class="cl-add-btn" data-parent="" data-container="${containerId}" title="항목 추가">+</button>` : ''}
    </div>
    <div class="cl-tree-children">`;
  html += CL.tree.map(node => clRenderTreeNode(node, CL.searchQuery, isTeacher, containerId)).join('');
  html += '</div></div>';
  html += '</div></div>';
  container.innerHTML = html;

  // Draw SVG lines after render
  // Draw lines after layout, and redraw after images load
  requestAnimationFrame(() => {
    clDrawTreeLines(containerId);
    // Debounced redraw after images load
    let redrawTimer = null;
    const imgs = container.querySelectorAll('img');
    imgs.forEach(img => {
      if (!img.complete) img.addEventListener('load', () => {
        clearTimeout(redrawTimer);
        redrawTimer = setTimeout(() => clDrawTreeLines(containerId), 50);
      }, { once: true });
    });
  });
}

function clRenderTreeNode(node, query, isTeacher, containerId) {
  const isCategory = node.cardType === 'category';
  const isMine = node.deviceId === deviceId;
  const canEdit = clIsMyWorkspace() && (isTeacher || isMine);
  const canAdd = clIsMyWorkspace() && (!isBoardClosed() || isTeacher);
  const color = node.color || (isCategory ? CL_COLORS[Math.abs(hashStr(node.id)) % CL_COLORS.length] : '#6B7280');
  const starCount = (node.stars || []).length;
  const isStarred = (node.stars || []).includes(deviceId);
  const time = node.createdAt ? formatDateShort(node.createdAt.toDate()) : '';

  let titleMatch = escapeHtml(node.title || '');
  if (query) {
    const re = new RegExp(`(${escapeRegex(query)})`, 'gi');
    titleMatch = titleMatch.replace(re, '<mark>$1</mark>');
  }

  const imgHtml = node.imageUrl
    ? `<div class="cl-node-image"><img src="${escapeHtml(node.imageUrl)}" alt="" loading="lazy"></div>`
    : '';

  const descHtml = node.content
    ? `<div class="cl-node-desc">${escapeHtml(truncate(node.content, 80))}</div>`
    : '';

  const childrenHtml = (node.children && node.children.length > 0)
    ? `<div class="cl-tree-children">${node.children.map(c => clRenderTreeNode(c, query, isTeacher, containerId)).join('')}</div>`
    : '';

  // Add button only on category nodes
  const addBtnHtml = (isCategory && canAdd) ? `<button class="cl-add-btn" data-parent="${escapeHtml(node.id)}" data-container="${containerId}" title="항목 추가">+</button>` : '';

  return `
    <div class="cl-tree-node" data-id="${escapeHtml(node.id)}">
      <div class="cl-node-box ${isCategory ? 'cl-category-box' : 'cl-entry-box'} ${isMine ? 'cl-node-mine' : ''}"
           data-id="${escapeHtml(node.id)}" data-type="${node.cardType}"
           style="border-left-color:${color}"
           draggable="${canEdit ? 'true' : 'false'}">
        <div class="cl-node-header">
          <span class="cl-node-icon">${isCategory ? '📁' : '📄'}</span>
          <span class="cl-node-title">${titleMatch}</span>
          ${canEdit && !isBoardClosed() ? `<button class="cl-node-menu-btn" data-id="${escapeHtml(node.id)}" title="메뉴">⋮</button>` : ''}
        </div>
        ${imgHtml}
        ${descHtml}
        <div class="cl-node-meta">
          <span class="cl-node-author">${escapeHtml(node.name || '')}</span>
          <span class="cl-node-time">${time}</span>
          <button class="cl-star-btn ${isStarred ? 'cl-starred' : ''}" data-id="${escapeHtml(node.id)}" title="추천">
            ${isStarred ? '★' : '☆'} ${starCount > 0 ? starCount : ''}
          </button>
        </div>
        ${addBtnHtml}
      </div>
      ${childrenHtml}
    </div>`;
}

function hashStr(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Draw SVG curved connection lines between tree nodes */
function clDrawTreeLines(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  // Remove old SVGs
  container.querySelectorAll('.cl-tree-svg').forEach(s => s.remove());

  const nodes = container.querySelectorAll('.cl-tree-node');
  nodes.forEach(node => {
    const box = node.querySelector(':scope > .cl-node-box');
    const childrenContainer = node.querySelector(':scope > .cl-tree-children');
    if (!box || !childrenContainer) return;

    const childNodes = childrenContainer.querySelectorAll(':scope > .cl-tree-node > .cl-node-box');
    if (childNodes.length === 0) return;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('cl-tree-svg');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = node.scrollWidth + 'px';
    svg.style.height = node.scrollHeight + 'px';
    svg.style.pointerEvents = 'none';
    svg.style.overflow = 'visible';
    svg.style.zIndex = '0';
    node.insertBefore(svg, childrenContainer);

    const nodeRect = node.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    // Horizontal layout: parent right edge → child left edge
    const pX = boxRect.right - nodeRect.left;
    const pY = boxRect.top + boxRect.height / 2 - nodeRect.top;

    childNodes.forEach(childBox => {
      const childRect = childBox.getBoundingClientRect();
      const cX = childRect.left - nodeRect.left;
      const cY = childRect.top + childRect.height / 2 - nodeRect.top;

      const midX = pX + (cX - pX) * 0.5;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${pX} ${pY} C ${midX} ${pY}, ${midX} ${cY}, ${cX} ${cY}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#B0BEC5');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      svg.appendChild(path);
    });
  });
}

// ══════════════════════════════════════
//  CLASSIFY: FOLDER VIEW
// ══════════════════════════════════════
function clRenderFolderView(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const isTeacher = CL.isTeacher;

  // Breadcrumb
  let breadcrumb = clBuildBreadcrumb();

  // Get children of current folder
  const currentChildren = CL.cards.filter(c => (c.parentId || '') === CL.folderParentId);
  currentChildren.sort((a, b) => {
    // Categories first, then entries
    if (a.cardType !== b.cardType) return a.cardType === 'category' ? -1 : 1;
    return (a.order || 0) - (b.order || 0);
  });

  let html = `<div class="cl-folder-view">`;
  html += `<div class="cl-breadcrumb">${breadcrumb}</div>`;

  html += '<div class="cl-folder-grid">';
  // Navigation card: go up (only when inside a subfolder)
  if (CL.folderParentId) {
    const parentCard = CL.cardMap[CL.folderParentId];
    const grandParentId = parentCard?.parentId || '';
    html += `<div class="cl-folder-card cl-folder-nav" data-nav-parent="${escapeHtml(grandParentId)}">
      <div class="cl-folder-card-header"><span class="cl-folder-icon">⬆️</span><span class="cl-folder-title">상위 폴더로</span></div>
    </div>`;
  }

  if (currentChildren.length === 0) {
    html += '<div class="empty-state" style="padding:30px;grid-column:1/-1"><p>이 폴더는 비어 있습니다.</p></div>';
  } else {
    currentChildren.forEach(card => {
      const isCategory = card.cardType === 'category';
      const isMine = card.deviceId === deviceId;
      const canEdit = clIsMyWorkspace() && (isTeacher || isMine);
      const childCount = CL.allCards.filter(c => c.parentId === card.id && c.cardType !== 'category').length;
      const color = card.color || (isCategory ? CL_COLORS[Math.abs(hashStr(card.id)) % CL_COLORS.length] : '#6B7280');
      const starCount = (card.stars || []).length;
      const isStarred = (card.stars || []).includes(deviceId);
      const time = card.createdAt ? formatDateShort(card.createdAt.toDate()) : '';

      html += `
        <div class="cl-folder-card ${isCategory ? 'cl-folder-category' : 'cl-folder-entry'} ${isMine ? 'cl-node-mine' : ''}"
             data-id="${escapeHtml(card.id)}" data-type="${card.cardType}"
             style="border-top-color:${color}">
          <div class="cl-folder-card-header">
            <span class="cl-folder-icon">${isCategory ? '📁' : '📄'}</span>
            <span class="cl-folder-title">${escapeHtml(card.title || '')}</span>
            ${canEdit && !isBoardClosed() ? `<span class="cl-folder-actions">
              <button class="cl-folder-edit-btn" data-id="${escapeHtml(card.id)}" title="수정">✏️</button>
              <button class="cl-folder-del-btn" data-id="${escapeHtml(card.id)}" title="삭제">🗑️</button>
            </span>` : ''}
          </div>
          ${card.imageUrl ? `<div class="cl-folder-img"><img src="${escapeHtml(card.imageUrl)}" alt="" loading="lazy"></div>` : ''}
          ${card.content ? `<div class="cl-folder-desc">${escapeHtml(truncate(card.content, 60))}</div>` : ''}
          <div class="cl-folder-meta">
            <span>${escapeHtml(card.name || '')} · ${time}</span>
            <span>
              ${isCategory ? `<span class="cl-child-count">${childCount}개</span>` : ''}
              <button class="cl-star-btn ${isStarred ? 'cl-starred' : ''}" data-id="${escapeHtml(card.id)}">
                ${isStarred ? '★' : '☆'} ${starCount > 0 ? starCount : ''}
              </button>
            </span>
          </div>
        </div>`;
    });
  }
  html += '</div>'; // cl-folder-grid
  html += '</div>'; // cl-folder-view
  container.innerHTML = html;
}

function clBuildBreadcrumb() {
  const parts = [];
  let pid = CL.folderParentId;
  while (pid && CL.cardMap[pid]) {
    parts.unshift(CL.cardMap[pid]);
    pid = CL.cardMap[pid].parentId || '';
  }

  let html = `<button class="cl-breadcrumb-item cl-breadcrumb-root" data-parent="">🏠 전체</button>`;
  parts.forEach(p => {
    html += `<span class="cl-breadcrumb-sep">›</span>`;
    html += `<button class="cl-breadcrumb-item" data-parent="${escapeHtml(p.id)}">${escapeHtml(p.title || '')}</button>`;
  });
  return html;
}

// ══════════════════════════════════════
//  CLASSIFY: BOOK VIEW (풀스크린 사전 프레젠테이션)
// ══════════════════════════════════════

/** Build book pages array: cover → toc → content spreads
 *  Each spread = left page + right page. Each page = one card.
 *  Top-level category: blank left + chapter divider right. */
function clBuildBookPages() {
  const pages = [];
  const categories = CL.tree;

  // Cover
  pages.push({ type: 'cover' });

  // TOC
  const tocItems = [];
  function collectTocItems(nodes, depth) {
    for (const node of nodes) {
      if (node.cardType === 'category') {
        tocItems.push({ ...node, depth });
        const subCats = (node.children || []).filter(c => c.cardType === 'category');
        collectTocItems(subCats, depth + 1);
      }
    }
  }
  collectTocItems(categories, 0);
  pages.push({ type: 'toc', categories: tocItems });

  // Collect all "sides" in order, then pair into spreads
  const sides = [];

  function addCategoryPages(cat, depth) {
    const directEntries = (cat.children || []).filter(c => c.cardType !== 'category');
    const subCats = (cat.children || []).filter(c => c.cardType === 'category');

    if (depth === 0) {
      // Top-level: blank left + chapter divider right
      sides.push(null);
      sides.push({ type: 'chapter', card: cat, depth });
    } else {
      sides.push({ type: 'section', card: cat, depth });
    }

    for (const entry of directEntries) {
      sides.push({ type: 'entry', card: entry });
    }

    for (const sc of subCats) {
      addCategoryPages(sc, depth + 1);
    }
  }

  for (const cat of categories) {
    addCategoryPages(cat, 0);
  }

  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    // Mobile: one side per page
    for (const side of sides) {
      if (side) pages.push({ type: 'single', side });
    }
    if (pages.length <= 2) pages.push({ type: 'single', side: null });
  } else {
    // Desktop: pair sides into spreads (left, right)
    while (sides.length >= 2) {
      pages.push({ type: 'spread', left: sides.shift(), right: sides.shift() });
    }
    if (sides.length === 1) {
      pages.push({ type: 'spread', left: sides.shift(), right: null });
    }
    if (pages.length <= 2) {
      pages.push({ type: 'spread', left: null, right: null });
    }
  }

  return pages;
}

/** Preload all card images in background */
function clPreloadImages() {
  for (const c of CL.cards) {
    if (c.imageUrl) { const img = new Image(); img.src = c.imageUrl; }
  }
}

/** Render the fullscreen book overlay */
function clRenderBookView(containerId) {
  clPreloadImages();
  // Remove existing overlay if any
  let overlay = document.getElementById('cl-book-overlay');
  if (overlay) overlay.remove();

  const pages = clBuildBookPages();
  const totalPages = pages.length;
  const page = Math.min(CL.bookPage || 0, totalPages - 1);
  CL.bookPage = page;
  CL.bookPages = pages;

  overlay = document.createElement('div');
  overlay.id = 'cl-book-overlay';
  overlay.innerHTML = `
    <div class="clb-container">
      <div class="clb-page-wrapper">
        ${clRenderBookPage(pages[page], page, totalPages)}
      </div>
      <div class="clb-controls">
        <div class="clb-pdf-btns">
          <button class="clb-download-pdf" data-mode="normal" title="인쇄 / PDF 저장">🖨 인쇄</button>
          <button class="clb-download-pdf" data-mode="booklet" title="소책자 인쇄 (접어서 제본)">📖 소책자</button>
        </div>
        <button class="clb-close" title="닫기">✕</button>
        <div class="clb-nav">
          <button class="clb-prev" ${page <= 0 ? 'disabled' : ''}>‹</button>
          <span class="clb-page-num">${page + 1} / ${totalPages}</span>
          <button class="clb-next" ${page >= totalPages - 1 ? 'disabled' : ''}>›</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('clb-open'));

  // Hide parent UI
  const parentView = document.getElementById(containerId)?.closest('.view');
  if (parentView) parentView.style.display = 'none';
  CL._bookParentView = parentView;
  CL._bookContainerId = containerId;
}

/** Calculate the half-page number for a given page index */
function clGetHalfPageNums(pages, pageIdx) {
  let num = 0;
  for (let i = 0; i < pageIdx; i++) {
    const p = pages[i];
    num += (p.type === 'spread') ? 2 : 1;
  }
  const cur = pages[pageIdx];
  if (cur.type === 'spread') return [num + 1, num + 2];
  return [num + 1];
}

function clGetTotalHalfPages(pages) {
  let n = 0;
  for (const p of pages) n += (p.type === 'spread') ? 2 : 1;
  return n;
}

/** Render a single book page content based on type */
function clRenderBookPage(pageData, pageIdx, totalPages) {
  if (!pageData) return '';

  if (pageData.type === 'cover') {
    const title = clGetWsTitle() || '사전';
    const desc = currentBoard?.description || '';
    const settings = currentBoard?.settings || {};
    const members = currentBoard?.members || {};
    const groups = currentBoard?.groups || {};
    // Collect workspace name and participant names
    let wsName = '';
    const participantNames = [];
    if (CL.workspaceId) {
      if (settings.groupMode === 'team') {
        for (const [gid, g] of Object.entries(groups)) {
          if (gid === CL.workspaceId) {
            wsName = g.name || gid;
            // Collect team member names
            for (const [did, m] of Object.entries(members)) {
              if (m.groupId === gid && m.name) participantNames.push(m.name);
            }
            break;
          }
        }
      } else {
        for (const [did, m] of Object.entries(members)) {
          if (did === CL.workspaceId) {
            wsName = m.name || '';
            if (m.name) participantNames.push(m.name);
            break;
          }
        }
      }
    }
    // Also collect unique author names from cards as fallback
    if (participantNames.length === 0) {
      const nameSet = new Set();
      for (const c of CL.cards) {
        if (c.name && c.name.trim()) nameSet.add(c.name.trim());
      }
      participantNames.push(...nameSet);
    }
    const cardCount = CL.cards.filter(c => c.cardType !== 'category').length;
    const catCount = CL.cards.filter(c => c.cardType === 'category').length;
    const participantsHtml = participantNames.length > 0
      ? `<div class="clb-cover-participants">${participantNames.map(n => `<span class="clb-cover-name">${escapeHtml(n)}</span>`).join('')}</div>`
      : '';

    // QR code for read-only book link
    const bookUrl = getBookLink(currentBoardCode, CL.workspaceId);
    const qrDataUrl = clGenerateQrDataUrl(bookUrl, 100);
    const qrHtml = qrDataUrl
      ? `<div class="clb-cover-qr"><img src="${qrDataUrl}" alt="QR" width="72" height="72"><span>온라인으로 보기</span></div>`
      : '';

    return `
      <div class="clb-cover">
        <div class="clb-cover-ornament top"></div>
        <div class="clb-cover-content">
          <div class="clb-cover-label">우리들의 사전</div>
          <h1 class="clb-cover-title">${escapeHtml(title)}</h1>
          ${desc ? `<p class="clb-cover-desc">${escapeHtml(desc)}</p>` : ''}
          ${wsName ? `<div class="clb-cover-author">${escapeHtml(wsName)}</div>` : ''}
          ${participantsHtml}
          <div class="clb-cover-stats">${catCount}개 분류 · ${cardCount}개 항목</div>
        </div>
        ${qrHtml}
        <div class="clb-cover-ornament bottom"></div>
        <div class="clb-page-number">${pageIdx + 1}</div>
      </div>`;
  }

  if (pageData.type === 'toc') {
    const cats = pageData.categories || [];
    let tocHtml = cats.map(cat => {
      const entryCount = (cat.children || []).filter(c => c.cardType !== 'category').length;
      const color = cat.color || CL_COLORS[Math.abs(hashStr(cat.id)) % CL_COLORS.length];
      const indent = (cat.depth || 0) * 20;
      const isSub = (cat.depth || 0) > 0;
      return `<div class="clb-toc-item ${isSub ? 'clb-toc-sub' : ''}" data-toc-id="${escapeHtml(cat.id)}" style="padding-left:${8 + indent}px">
        <span class="clb-toc-dot${isSub ? ' clb-toc-dot-sub' : ''}" style="background:${color}"></span>
        <span class="clb-toc-label">${escapeHtml(cat.title || '')}</span>
        <span class="clb-toc-line"></span>
        <span class="clb-toc-count">${entryCount > 0 ? entryCount + '개' : ''}</span>
      </div>`;
    }).join('');

    return `
      <div class="clb-toc">
        <div class="clb-page-header">목 차</div>
        <div class="clb-toc-list">${tocHtml}</div>
        <div class="clb-page-number">${pageIdx + 1}</div>
      </div>`;
  }

  if (pageData.type === 'spread') {
    const pages = CL.bookPages || [];
    const nums = clGetHalfPageNums(pages, pageIdx);
    const total = clGetTotalHalfPages(pages);
    return `
      <div class="clb-spread">
        <div class="clb-left">${clRenderBookSide(pageData.left)}<div class="clb-page-number">${nums[0]}</div></div>
        <div class="clb-spine"></div>
        <div class="clb-right">${clRenderBookSide(pageData.right)}<div class="clb-page-number">${nums[1]}</div></div>
      </div>`;
  }

  if (pageData.type === 'single') {
    return `
      <div class="clb-single">
        ${clRenderBookSide(pageData.side)}
        <div class="clb-page-number">${pageIdx + 1}</div>
      </div>`;
  }

  return '';
}

/** Build breadcrumb HTML for a card's ancestor path */
function clBookBreadcrumb(card) {
  const ancestors = [];
  let pid = card.parentId;
  while (pid && CL.cardMap[pid]) {
    ancestors.unshift(CL.cardMap[pid]);
    pid = CL.cardMap[pid].parentId || '';
  }
  if (ancestors.length === 0) return '';
  const crumbs = ancestors.map(a => {
    const color = a.color || CL_COLORS[Math.abs(hashStr(a.id)) % CL_COLORS.length];
    return `<span class="clb-crumb" style="--crumb-color:${color}">${escapeHtml(a.title || '')}</span>`;
  });
  return `<div class="clb-breadcrumb">${crumbs.join('<span class="clb-crumb-sep">›</span>')}</div>`;
}

/** Render one side (left or right) of a spread */
function clRenderBookSide(side) {
  if (!side) {
    return '<div class="clb-side-empty"><div class="clb-watermark">📖</div></div>';
  }

  const card = side.card;
  const isCategory = card.cardType === 'category';
  const color = card.color || (isCategory ? CL_COLORS[Math.abs(hashStr(card.id)) % CL_COLORS.length] : '#6B7280');
  const starCount = (card.stars || []).length;
  const isStarred = (card.stars || []).includes(deviceId);

  // Chapter divider (top-level category, right side of spread)
  if (side.type === 'chapter') {
    const childCount = (card.children || []).filter(c => c.cardType !== 'category').length;
    const subCatCount = (card.children || []).filter(c => c.cardType === 'category').length;
    return `
      <div class="clb-chapter" style="--ch-color:${color}">
        <div class="clb-chapter-deco top" style="background:${color}"></div>
        <div class="clb-chapter-body">
          <div class="clb-chapter-label">Chapter</div>
          <h1 class="clb-chapter-title">${escapeHtml(card.title || '')}</h1>
          ${card.content ? `<p class="clb-chapter-desc">${escapeHtml(card.content)}</p>` : ''}
          ${card.imageUrl ? `<div class="clb-chapter-img"><img src="${escapeHtml(card.imageUrl)}" alt="" loading="lazy"></div>` : ''}
          <div class="clb-chapter-stats">
            ${childCount}개 항목${subCatCount > 0 ? ` · ${subCatCount}개 하위 분류` : ''}
          </div>
          <button class="cl-star-btn ${isStarred ? 'cl-starred' : ''}" data-id="${escapeHtml(card.id)}">
            ${isStarred ? '★' : '☆'} ${starCount > 0 ? starCount : ''}
          </button>
        </div>
        <div class="clb-chapter-deco bottom" style="background:${color}"></div>
      </div>`;
  }

  if (side.type === 'section') {
    // Sub-level category — depth-based progressive scaling
    const depth = side.depth || 1;
    const childCount = (card.children || []).filter(c => c.cardType !== 'category').length;
    const subCatCount = (card.children || []).filter(c => c.cardType === 'category').length;
    // Progressive sizing: depth 1 = largest, each level shrinks
    const titleSize = Math.max(1.0, 1.6 - (depth - 1) * 0.2);
    const barWidth = Math.max(20, 44 - (depth - 1) * 8);
    const barHeight = Math.max(2, 4 - (depth - 1));
    const labelText = depth === 1 ? '분류' : `${'하위 '.repeat(Math.min(depth - 1, 3))}분류`;
    const breadcrumb = clBookBreadcrumb(card);
    return `
      <div class="clb-section clb-section-d${Math.min(depth, 4)}" style="--sec-color:${color}">
        ${breadcrumb}
        <div class="clb-section-bar" style="background:${color};width:${barWidth}px;height:${barHeight}px"></div>
        <div class="clb-section-body">
          <div class="clb-section-label">${labelText}</div>
          <h2 class="clb-section-title" style="font-size:${titleSize}rem">${escapeHtml(card.title || '')}</h2>
          ${card.content ? `<p class="clb-section-desc">${escapeHtml(card.content)}</p>` : ''}
          ${card.imageUrl ? `<div class="clb-section-img"><img src="${escapeHtml(card.imageUrl)}" alt="" loading="lazy"></div>` : ''}
          <div class="clb-section-stats">
            ${childCount}개 항목${subCatCount > 0 ? ` · ${subCatCount}개 하위 분류` : ''}
          </div>
          <button class="cl-star-btn ${isStarred ? 'cl-starred' : ''}" data-id="${escapeHtml(card.id)}">
            ${isStarred ? '★' : '☆'} ${starCount > 0 ? starCount : ''}
          </button>
        </div>
      </div>`;
  }

  // Entry-image: full-page image display
  if (side.type === 'entry-image') {
    const breadcrumb = clBookBreadcrumb(card);
    return `
      <div class="clb-entry-image-page" style="--entry-color:${color}">
        ${breadcrumb}
        <div class="clb-entry-image-full">
          <img src="${escapeHtml(card.imageUrl)}" alt="" loading="lazy">
        </div>
        <div class="clb-entry-image-caption">${escapeHtml(card.title || '')}</div>
      </div>`;
  }

  // Entry — dictionary-style card (image + text on one page)
  const breadcrumb = clBookBreadcrumb(card);
  return `
    <div class="clb-entry" data-id="${escapeHtml(card.id)}" data-type="${card.cardType}" style="--entry-color:${color}">
      ${breadcrumb}
      <div class="clb-entry-word">${escapeHtml(card.title || '')}</div>
      ${card.imageUrl ? `<div class="clb-entry-img"><img src="${escapeHtml(card.imageUrl)}" alt="" loading="lazy"></div>` : ''}
      ${card.content ? `<div class="clb-entry-desc">${escapeHtml(card.content)}</div>` : ''}
      <div class="clb-entry-footer">
        <span class="clb-entry-author">${escapeHtml(card.name || '')}</span>
        <button class="cl-star-btn ${isStarred ? 'cl-starred' : ''}" data-id="${escapeHtml(card.id)}">
          ${isStarred ? '★' : '☆'} ${starCount > 0 ? starCount : ''}
        </button>
      </div>
    </div>`;
}

/** Navigate book and re-render page content only */
window.clBookNavigate = function(dir) {
  const pages = CL.bookPages;
  if (!pages) return;
  const maxPage = pages.length - 1;
  const newPage = Math.max(0, Math.min(maxPage, (CL.bookPage || 0) + dir));
  if (newPage === CL.bookPage) return;
  CL.bookPage = newPage;

  const overlay = document.getElementById('cl-book-overlay');
  if (!overlay) return;
  const wrapper = overlay.querySelector('.clb-page-wrapper');
  const pageNum = overlay.querySelector('.clb-page-num');
  const prevBtn = overlay.querySelector('.clb-prev');
  const nextBtn = overlay.querySelector('.clb-next');

  // Animate page flip
  const direction = dir > 0 ? 'clb-flip-left' : 'clb-flip-right';
  wrapper.classList.add(direction);
  setTimeout(() => {
    wrapper.innerHTML = clRenderBookPage(pages[newPage], newPage, pages.length);
    wrapper.classList.remove(direction);
    wrapper.classList.add('clb-flip-in');
    setTimeout(() => wrapper.classList.remove('clb-flip-in'), 300);
  }, 150);

  pageNum.textContent = `${newPage + 1} / ${pages.length}`;
  prevBtn.disabled = newPage <= 0;
  nextBtn.disabled = newPage >= maxPage;
};

/** Jump to a specific book page */
window.clBookGoTo = function(pageIdx) {
  const pages = CL.bookPages;
  if (!pages) return;
  CL.bookPage = Math.max(0, Math.min(pages.length - 1, pageIdx));

  const overlay = document.getElementById('cl-book-overlay');
  if (!overlay) return;
  const wrapper = overlay.querySelector('.clb-page-wrapper');
  const pageNum = overlay.querySelector('.clb-page-num');
  const prevBtn = overlay.querySelector('.clb-prev');
  const nextBtn = overlay.querySelector('.clb-next');

  wrapper.innerHTML = clRenderBookPage(pages[CL.bookPage], CL.bookPage, pages.length);
  pageNum.textContent = `${CL.bookPage + 1} / ${pages.length}`;
  prevBtn.disabled = CL.bookPage <= 0;
  nextBtn.disabled = CL.bookPage >= pages.length - 1;
};

/** Close book overlay and restore UI */
window.clCloseBook = function() {
  const overlay = document.getElementById('cl-book-overlay');
  if (overlay) {
    overlay.classList.remove('clb-open');
    setTimeout(() => overlay.remove(), 300);
  }
  if (CL._bookParentView) CL._bookParentView.style.display = '';
  // Switch back to tree view
  CL.currentView = 'tree';
  const containerId = CL._bookContainerId;
  if (containerId) {
    const parent = document.getElementById(containerId)?.closest('.view');
    if (parent) parent.querySelectorAll('.cl-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'tree'));
    clRenderCurrentView(containerId);
    const isBoard = containerId === 'cl-board-container';
    location.hash = clBuildHash(isBoard);
  }
};

// Book overlay event delegation
document.addEventListener('click', (e) => {
  const overlay = document.getElementById('cl-book-overlay');
  if (!overlay) return;

  if (e.target.closest('.clb-close')) { clCloseBook(); return; }
  const pdfBtn = e.target.closest('.clb-download-pdf');
  if (pdfBtn) {
    // window.open must be called synchronously inside click handler
    const printWin = window.open('', '_blank');
    if (!printWin) { toast('팝업이 차단되었습니다. 팝업을 허용해주세요.'); return; }
    clBookPrint(pdfBtn.dataset.mode || 'normal', printWin);
    return;
  }
  if (e.target.closest('.clb-prev')) { clBookNavigate(-1); return; }
  if (e.target.closest('.clb-next')) { clBookNavigate(1); return; }

  // TOC item click → jump to that category's page
  const tocItem = e.target.closest('.clb-toc-item');
  if (tocItem) {
    const catId = tocItem.dataset.tocId;
    if (catId) {
      // Find the chapter or spread page containing this category
      const pages = CL.bookPages || [];
      let targetPage = 2;
      for (let i = 2; i < pages.length; i++) {
        const p = pages[i];
        if (p.type === 'chapter' && p.card?.id === catId) { targetPage = i; break; }
        if (p.type === 'spread') {
          if (p.left?.card?.id === catId || p.right?.card?.id === catId) { targetPage = i; break; }
        }
      }
      clBookGoTo(targetPage);
    }
    return;
  }

  // Star button inside book
  const starBtn = e.target.closest('.cl-star-btn');
  if (starBtn && starBtn.dataset.id) { clToggleStar(starBtn.dataset.id); return; }

  // Tap left/right half of page to navigate (mobile-friendly)
  const pageWrapper = e.target.closest('.clb-page-wrapper');
  if (pageWrapper && !e.target.closest('button, a, .clb-toc-item, .cl-star-btn')) {
    const rect = pageWrapper.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width * 0.35) { clBookNavigate(-1); }
    else if (x > rect.width * 0.65) { clBookNavigate(1); }
  }
});

// ── Book Print (인쇄용 HTML 새 창) ──

/** Render a single half-page HTML with page number */
function clRenderHalfPage(pageOrSide, pageNum) {
  const numHtml = pageNum ? `<div class="clb-page-number">${pageNum}</div>` : '';
  if (!pageOrSide) return numHtml ? `<div style="position:relative;height:100%">${numHtml}</div>` : '';
  if (pageOrSide.type === 'cover' || pageOrSide.type === 'toc') {
    return clRenderBookPage(pageOrSide, pageNum - 1, 0);
  }
  return `<div style="position:relative;height:100%">${clRenderBookSide(pageOrSide)}${numHtml}</div>`;
}

/** Open print-ready HTML window: normal or booklet mode */
function clBookPrint(mode = 'normal', printWin) {
  const pages = CL.bookPages;
  if (!pages || pages.length === 0) { toast('페이지가 없습니다.'); return; }
  if (!printWin) { printWin = window.open('', '_blank'); }
  if (!printWin) { toast('팝업이 차단되었습니다.'); return; }

  // Flatten pages into individual half-pages with page numbers
  const halves = []; // {side, num}
  let num = 1;
  for (const page of pages) {
    if (page.type === 'cover' || page.type === 'toc') {
      halves.push({ side: page, num: num++ });
    } else if (page.type === 'single') {
      halves.push({ side: page.side, num: num++ });
    } else if (page.type === 'spread') {
      halves.push({ side: page.left, num: num++ });
      halves.push({ side: page.right, num: num++ });
    }
  }
  const realCount = halves.length;

  const title = escapeHtml(clGetWsTitle() || currentBoard?.title || '사전');
  let bodyHtml = '';

  if (mode === 'booklet') {
    // Pad to multiple of 4
    while (halves.length % 4 !== 0) halves.push({ side: null, num: 0 });
    const total = halves.length;
    const sheetCount = total / 4;

    const rh = (h) => clRenderHalfPage(h.side, h.num <= realCount ? h.num : 0);
    for (let i = 0; i < sheetCount; i++) {
      const fl = halves[total - 1 - 2 * i];
      const fr = halves[2 * i];
      bodyHtml += `<div class="print-sheet">
        <div class="print-half">${rh(fl)}</div>
        <div class="print-spine"></div>
        <div class="print-half">${rh(fr)}</div>
      </div>`;
      const bl = halves[2 * i + 1];
      const br = halves[total - 2 - 2 * i];
      bodyHtml += `<div class="print-sheet">
        <div class="print-half">${rh(bl)}</div>
        <div class="print-spine"></div>
        <div class="print-half">${rh(br)}</div>
      </div>`;
    }
  } else {
    for (const h of halves) {
      bodyHtml += `<div class="print-page">${clRenderHalfPage(h.side, h.num)}</div>`;
    }
  }

  const isBooklet = mode === 'booklet';
  printWin.document.write(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${title} - ${isBooklet ? '소책자 인쇄' : '인쇄'}</title>
<link rel="stylesheet" href="${location.origin}/style.css">
<style>
@page { margin: 0; size: ${isBooklet ? 'landscape' : 'portrait'}; }
* { box-sizing: border-box; }
body { margin:0; padding:0; background:#fff; font-family:'Pretendard',sans-serif; }

/* 일반 모드: 한 쪽 한 페이지 */
.print-page {
  width:100vw; height:100vh;
  padding:40px 36px; display:flex; flex-direction:column;
  page-break-after:always; overflow:hidden;
  background:linear-gradient(170deg, #faf8f5 0%, #f5f1eb 100%);
}
.print-page:last-child { page-break-after:auto; }

/* 소책자 모드: 가로 2쪽 모아 */
.print-sheet {
  width:100vw; height:100vh;
  display:flex; page-break-after:always; overflow:hidden;
}
.print-sheet:last-child { page-break-after:auto; }
.print-half {
  flex:1; padding:28px 24px; display:flex; flex-direction:column;
  overflow:hidden;
  background:linear-gradient(170deg, #faf8f5 0%, #f5f1eb 100%);
}
.print-spine {
  width:1px; flex-shrink:0; background:#d4c5b0;
}

/* 인쇄 시 — 기본 book 뷰 스타일 재사용, 최소 오버라이드 */
.clb-cover, .clb-toc, .clb-chapter, .clb-section,
.clb-entry, .clb-entry-image-page, .clb-side-empty {
  width:100% !important; height:100%;
  box-shadow:none !important; border-radius:0 !important;
  aspect-ratio:auto !important;
}
.clb-spread { display:contents !important; }
.clb-left, .clb-right, .clb-spine { display:none !important; }
.clb-cover { display:flex; flex-direction:column; justify-content:center; align-items:center; }
.clb-entry { flex:1; }
.cl-star-btn { display:none !important; }
.clb-page-number { position:absolute; bottom:8px; right:12px; font-size:.65rem; color:#b8a68e; }
.print-half, .print-page { position:relative; }

/* 플로팅 인쇄 버튼 */
.print-fab {
  position:fixed; bottom:24px; right:24px; z-index:100;
  display:flex; gap:8px;
}
.print-fab button {
  padding:10px 20px; border:none; border-radius:24px;
  font-size:.95rem; font-weight:600; cursor:pointer;
  box-shadow:0 2px 8px rgba(0,0,0,.3);
}
.print-fab-print { background:#4A90D9; color:#fff; }
.print-fab-print:hover { background:#3a7bc8; }
.print-fab-close { background:#fff; color:#555; }
.print-fab-close:hover { background:#f0f0f0; }

/* 화면 미리보기용 (인쇄 전) */
@media screen {
  body { background:#888; }
  .print-page, .print-sheet {
    width:${isBooklet ? '297mm' : '210mm'};
    height:${isBooklet ? '210mm' : '297mm'};
    margin:10px auto; box-shadow:0 2px 12px rgba(0,0,0,.3);
  }
}
@media print { .print-fab { display:none !important; } }
</style>
</head><body>${bodyHtml}
<div class="print-fab">
  <button class="print-fab-close" onclick="window.close()">✕ 닫기</button>
  <button class="print-fab-print" onclick="window.print()">🖨 인쇄</button>
</div>
</body></html>`);
  printWin.document.close();
}

// Book keyboard navigation
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('cl-book-overlay')) return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') { clBookNavigate(-1); e.preventDefault(); }
  if (e.key === 'ArrowRight') { clBookNavigate(1); e.preventDefault(); }
  if (e.key === 'Escape') { clCloseBook(); e.preventDefault(); }
});

// Book touch swipe
{
  let bSwipeX = 0;
  document.addEventListener('touchstart', (e) => {
    if (!document.getElementById('cl-book-overlay')) return;
    bSwipeX = e.touches[0].clientX;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!document.getElementById('cl-book-overlay') || !bSwipeX) return;
    const dx = e.changedTouches[0].clientX - bSwipeX;
    bSwipeX = 0;
    if (Math.abs(dx) < 50) return;
    clBookNavigate(dx > 0 ? -1 : 1);
  }, { passive: true });
}

// ══════════════════════════════════════
//  CLASSIFY: CARD CRUD
// ══════════════════════════════════════
/** Open editor modal for new or existing card */
window.clOpenCardEditor = function(cardId, parentId, cardType) {
  if (!clIsMyWorkspace()) { toast('다른 사람의 워크스페이스입니다.'); return; }
  if (!CL.isTeacher && currentBoard?.members?.[deviceId]?.muted) { toast('쓰기가 중지되었습니다.'); return; }
  if (isBoardClosed() && !CL.isTeacher) { toast('마감된 보드입니다.'); return; }
  CL.editingCardId = cardId || null;
  CL.addParentId = parentId || '';
  CL.addType = cardType || 'entry';

  const modal = document.getElementById('classify-card-modal');
  const heading = document.getElementById('cl-editor-heading');
  const titleInput = document.getElementById('cl-editor-title');
  const contentInput = document.getElementById('cl-editor-content');
  const imgPreview = document.getElementById('cl-editor-img-preview');
  const dropzone = document.getElementById('cl-editor-dropzone');

  if (cardId && CL.cardMap[cardId]) {
    const card = CL.cardMap[cardId];
    heading.textContent = card.cardType === 'category' ? '분류기준 편집' : '카드 편집';
    titleInput.value = card.title || '';
    contentInput.value = card.content || '';
    if (card.imageUrl) {
      imgPreview.innerHTML = `<img src="${escapeHtml(card.imageUrl)}" alt=""><button class="cl-img-remove" onclick="clRemoveEditorImage()">✕</button>`;
      imgPreview.style.display = 'block';
      dropzone.style.display = 'none';
    } else {
      imgPreview.innerHTML = '';
      imgPreview.style.display = 'none';
      dropzone.style.display = 'block';
    }
    CL.editorImageUrl = card.imageUrl || '';
    CL.editorImagePath = card.imagePath || '';
  } else {
    heading.textContent = cardType === 'category' ? '분류기준 추가' : '카드 추가';
    titleInput.value = '';
    contentInput.value = '';
    imgPreview.innerHTML = '';
    imgPreview.style.display = 'none';
    dropzone.style.display = 'block';
    CL.editorImageUrl = '';
    CL.editorImagePath = '';
  }

  // Reset file input
  const fileInput = document.getElementById('cl-editor-file');
  if (fileInput) fileInput.value = '';
  CL.editorNewFile = null;

  // Hide image for category, but allow content (description)
  const isCategory = cardId ? CL.cardMap[cardId]?.cardType === 'category' : CL.addType === 'category';
  document.getElementById('cl-editor-image-group').style.display = isCategory ? 'none' : '';

  modal.style.display = 'flex';
  openModalHistory();
  setTimeout(() => titleInput.focus(), 100);
};

window.clRemoveEditorImage = function() {
  CL.editorImageUrl = '';
  CL.editorImagePath = '';
  CL.editorNewFile = null;
  document.getElementById('cl-editor-img-preview').innerHTML = '';
  document.getElementById('cl-editor-img-preview').style.display = 'none';
  document.getElementById('cl-editor-dropzone').style.display = 'block';
  const fileInput = document.getElementById('cl-editor-file');
  if (fileInput) fileInput.value = '';
};

window.clCloseCardEditor = function() { closeModal('classify-card-modal'); };

/** Handle image file selection in editor */
window.clEditorFileChange = function(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('이미지 파일만 업로드 가능합니다'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('10MB 이하 이미지만 가능합니다'); return; }
  CL.editorNewFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    const preview = document.getElementById('cl-editor-img-preview');
    preview.innerHTML = `<img src="${e.target.result}" alt=""><button class="cl-img-remove" onclick="clRemoveEditorImage()">✕</button>`;
    preview.style.display = 'block';
    document.getElementById('cl-editor-dropzone').style.display = 'none';
  };
  reader.readAsDataURL(file);
};

/** Upload image to Firebase Storage */
async function clUploadImage(file) {
  const path = `boards/${currentBoardCode}/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, path);
  const snap = await uploadBytesResumable(storageRef, file);
  const url = await getDownloadURL(snap.ref);
  return { url, path };
}

/** Save card from editor modal */
window.clSaveCard = async function() {
  const title = document.getElementById('cl-editor-title').value.trim();
  if (!title) { toast('제목을 입력하세요'); return; }
  const content = document.getElementById('cl-editor-content').value.trim();

  const saveBtn = document.getElementById('cl-editor-save');
  saveBtn.disabled = true;
  saveBtn.textContent = '저장 중...';

  try {
    let imageUrl = CL.editorImageUrl || '';
    let imagePath = CL.editorImagePath || '';

    // Upload new image if selected
    if (CL.editorNewFile) {
      const result = await clUploadImage(CL.editorNewFile);
      imageUrl = result.url;
      imagePath = result.path;
    }

    if (CL.editingCardId) {
      // Update existing card
      await updateDoc(doc(db, 'boards', currentBoardCode, 'submissions', CL.editingCardId), {
        title, content, imageUrl, imagePath
      });
      toast('수정되었습니다');
    } else {
      // Create new card
      const subId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const siblings = CL.allCards.filter(c => (c.parentId || '') === CL.addParentId);
      const maxOrder = siblings.reduce((max, c) => Math.max(max, c.order || 0), 0);

      await setDoc(doc(db, 'boards', currentBoardCode, 'submissions', subId), {
        cardType: CL.addType || 'entry',
        parentId: CL.addParentId || '',
        title,
        content,
        imageUrl,
        imagePath,
        order: maxOrder + 1000,
        color: '',
        stars: [],
        name: CL.isTeacher ? (currentUser?.displayName || currentUser?.email || '교사') : studentName,
        deviceId: CL.isTeacher ? 'teacher' : deviceId,
        workspaceId: CL.workspaceId || '',
        boardCode: currentBoardCode,
        createdAt: serverTimestamp()
      });
      toast('추가되었습니다!');
    }
    clCloseCardEditor();
  } catch (e) {
    console.error(e);
    toast('오류: ' + e.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '저장';
  }
};

/** Delete a card and all descendants */
function clGetDescendantIds(cardId) {
  const ids = [];
  function walk(pid) {
    CL.allCards.filter(c => c.parentId === pid).forEach(c => {
      ids.push(c.id);
      walk(c.id);
    });
  }
  walk(cardId);
  return ids;
}

async function clDeleteCard(cardId) {
  const card = CL.cardMap[cardId];
  if (!card) return;
  const preview = truncate(card.title || '(제목 없음)', 30);
  const hasChildren = CL.allCards.some(c => c.parentId === cardId);
  const msg = hasChildren
    ? `"${preview}" 및 하위 항목을 모두 삭제하시겠습니까?`
    : `"${preview}"을(를) 삭제하시겠습니까?`;
  if (!await showConfirm(msg)) return;

  // Collect all descendant IDs
  const toDelete = [cardId];
  function collectChildren(pid) {
    CL.allCards.filter(c => c.parentId === pid).forEach(c => {
      toDelete.push(c.id);
      collectChildren(c.id);
    });
  }
  collectChildren(cardId);

  try {
    await Promise.all(toDelete.map(id => {
      const c = CL.cardMap[id];
      if (c?.imagePath) deleteObject(ref(storage, c.imagePath)).catch(() => {});
      return deleteDoc(doc(db, 'boards', currentBoardCode, 'submissions', id));
    }));
    toast('삭제됨');
  } catch (e) { toast('삭제 실패'); }
}

/** Move a card to a new parent */
async function clMoveCard(cardId, newParentId) {
  if (cardId === newParentId) return;
  // Prevent moving to own descendant
  let pid = newParentId;
  while (pid) {
    if (pid === cardId) { toast('하위 항목으로 이동할 수 없습니다'); return; }
    pid = CL.cardMap[pid]?.parentId || '';
  }
  const siblings = CL.allCards.filter(c => (c.parentId || '') === newParentId);
  const maxOrder = siblings.reduce((max, c) => Math.max(max, c.order || 0), 0);
  try {
    await updateDoc(doc(db, 'boards', currentBoardCode, 'submissions', cardId), {
      parentId: newParentId,
      order: maxOrder + 1000
    });
    toast('이동됨');
  } catch (e) { toast('이동 실패'); }
}

/** Edit workspace root title (prompt-based) */
async function clEditWsTitle(containerId) {
  const current = clGetWsTitle();
  const newTitle = prompt('사전 제목을 입력하세요', current);
  if (newTitle === null || newTitle.trim() === current) return;
  const title = newTitle.trim() || (currentBoard?.title || '');
  try {
    const boardRef = doc(db, 'boards', currentBoardCode);
    const settings = currentBoard?.settings || {};
    if (settings.groupMode === 'team') {
      await updateDoc(boardRef, { [`groups.${CL.workspaceId}.wsTitle`]: title });
    } else {
      await updateDoc(boardRef, { [`members.${CL.workspaceId}.wsTitle`]: title });
    }
    toast('제목이 변경되었습니다');
  } catch (e) { console.error(e); toast('제목 변경 실패'); }
}

/** Toggle star on a card */
async function clToggleStar(cardId) {
  const subRef = doc(db, 'boards', currentBoardCode, 'submissions', cardId);
  try {
    const subDoc = await getDoc(subRef);
    if (!subDoc.exists()) return;
    const data = subDoc.data();
    const stars = data.stars || [];
    const isStarred = stars.includes(deviceId);
    await updateDoc(subRef, {
      stars: isStarred ? stars.filter(id => id !== deviceId) : [...stars, deviceId]
    });
  } catch (e) { console.error(e); toast('오류 발생'); }
}

/** Set card color */
async function clSetColor(cardId, color) {
  try {
    await updateDoc(doc(db, 'boards', currentBoardCode, 'submissions', cardId), { color });
    toast('색상 변경됨');
  } catch (e) { toast('색상 변경 실패'); }
}

// ══════════════════════════════════════
//  CLASSIFY: CONTEXT MENU & COLOR PICKER
// ══════════════════════════════════════
window.clShowContextMenu = function(cardId, x, y) {
  CL.contextCardId = cardId;
  const card = CL.cardMap[cardId];
  if (!card) return;
  const isCategory = card.cardType === 'category';
  const isMine = card.deviceId === deviceId;
  const canEdit = CL.isTeacher || isMine;
  if (!canEdit || isBoardClosed()) return;

  const menu = document.getElementById('cl-context-menu');
  let html = '';
  html += `<button class="cl-ctx-item" data-action="edit">✏️ 수정</button>`;
  if (isCategory) {
    html += `<button class="cl-ctx-item" data-action="add-category">📁 하위 분류기준 추가</button>`;
    html += `<button class="cl-ctx-item" data-action="add-entry">📝 카드 추가</button>`;
  }
  html += `<button class="cl-ctx-item" data-action="color">🎨 색상 변경</button>`;
  html += `<button class="cl-ctx-item" data-action="move">📦 이동</button>`;
  html += `<button class="cl-ctx-item cl-ctx-danger" data-action="delete">🗑 삭제</button>`;
  menu.innerHTML = html;

  // Position
  menu.style.display = 'block';
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  menu.style.left = (x + menuW > winW ? winW - menuW - 8 : x) + 'px';
  menu.style.top = (y + menuH > winH ? winH - menuH - 8 : y) + 'px';
};

window.clHideContextMenu = function() {
  document.getElementById('cl-context-menu').style.display = 'none';
  CL.contextCardId = null;
};

window.clShowColorPicker = function(cardId, x, y) {
  CL.contextCardId = cardId;
  const picker = document.getElementById('cl-color-picker');
  picker.innerHTML = CL_COLORS.map(c =>
    `<button class="cl-color-dot" style="background:${c}" data-color="${c}"></button>`
  ).join('') + `<button class="cl-color-dot cl-color-reset" data-color="" title="기본">✕</button>`;
  picker.style.display = 'flex';
  picker.style.left = x + 'px';
  picker.style.top = y + 'px';
};

window.clHideColorPicker = function() {
  document.getElementById('cl-color-picker').style.display = 'none';
};

window.clShowMoveDialog = function(cardId) {
  const card = CL.cardMap[cardId];
  if (!card) return;
  // Show prompt with category list
  const categories = CL.allCards.filter(c => c.cardType === 'category' && c.id !== cardId);
  if (categories.length === 0) { toast('이동할 카테고리가 없습니다'); return; }

  const modal = document.getElementById('cl-move-modal');
  const list = document.getElementById('cl-move-list');
  list.innerHTML = `<button class="cl-move-item" data-parent="">🏠 최상위 (루트)</button>` +
    categories.map(c => `<button class="cl-move-item" data-parent="${escapeHtml(c.id)}">${escapeHtml(c.title)}</button>`).join('');
  CL.moveCardId = cardId;
  modal.style.display = 'flex';
  openModalHistory();
};

window.clCloseMoveModal = function() { closeModal('cl-move-modal'); };

// ── Members Management Modal ──
window.clOpenMembersModal = function() {
  clRenderMembersList();
  document.getElementById('cl-members-modal').style.display = 'flex';
  openModalHistory();
};

window.clCloseMembersModal = function() { closeModal('cl-members-modal'); };

// ── 서로보기 토글 (공통: 과제/질문판/분류 모두 사용) ──
window.togglePeekFromBoard = async function() {
  const newPeek = currentBoard?.allowPeek === false ? true : false;
  try {
    await updateDoc(doc(db, 'boards', currentBoardCode), { allowPeek: newPeek });
    currentBoard.allowPeek = newPeek;
    updateAllPeekButtons();
    toast(newPeek ? '서로보기 허용됨' : '서로보기 차단됨');
  } catch (e) { toast('변경 실패'); }
};
window.clTogglePeekFromBoard = window.togglePeekFromBoard;

function updatePeekToggleBtn(btnId) {
  const btn = document.getElementById(btnId);
  if (btn) btn.textContent = currentBoard?.allowPeek === false ? '👁 서로보기 허용' : '🚫 서로보기 차단';
}

function updateAllPeekButtons() {
  updatePeekToggleBtn('cl-peek-toggle-btn');
  updatePeekToggleBtn('board-peek-toggle');
  updatePeekToggleBtn('inquiry-peek-toggle');
}

const clUpdatePeekButton = updateAllPeekButtons;

function clRenderMembersList() {
  const container = document.getElementById('cl-members-list');
  if (!container) return;
  const members = { ...(currentBoard?.members || {}) };
  const settings = currentBoard?.settings || {};
  const isTeam = settings.groupMode === 'team';
  const groups = currentBoard?.groups || {};
  // Supplement members from submissions
  CL.allCards.forEach(card => {
    if (card.deviceId && card.name && !members[card.deviceId]) {
      const memberData = { name: card.name };
      if (isTeam && card.workspaceId) memberData.groupId = card.workspaceId;
      members[card.deviceId] = memberData;
    }
  });
  const entries = Object.entries(members);

  if (entries.length === 0) {
    container.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:20px">참여자가 없습니다.</p>';
    return;
  }

  let html = '<table class="cl-members-table"><thead><tr><th>이름</th>';
  if (isTeam) html += '<th>모둠</th>';
  html += '<th>쓰기</th></tr></thead><tbody>';

  entries.forEach(([dId, m]) => {
    const isMuted = m.muted === true;
    const groupOptions = isTeam ? Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([gId, g]) => `<option value="${gId}" ${m.groupId === gId ? 'selected' : ''}>${g.name}</option>`).join('') : '';

    html += `<tr data-device-id="${escapeHtml(dId)}">
      <td><input type="text" class="cl-member-name-input" value="${escapeHtml(m.name || '')}" data-did="${escapeHtml(dId)}" style="width:100%;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:.85rem;"></td>
      ${isTeam ? `<td><select class="cl-member-group-select" data-did="${escapeHtml(dId)}" style="padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:.85rem;">${groupOptions}</select></td>` : ''}
      <td style="text-align:center"><button type="button" class="btn btn-sm ${isMuted ? 'btn-danger-light' : 'btn-secondary'} cl-member-mute-btn" data-did="${escapeHtml(dId)}" data-muted="${isMuted}">${isMuted ? '🔇 중지됨' : '✏️ 허용'}</button></td>
    </tr>`;
  });

  html += '</tbody></table>';
  html += '<button class="btn btn-primary btn-full" style="margin-top:16px" id="cl-members-save-all">저장</button>';
  container.innerHTML = html;

  // Mute toggle (UI only, saved on submit)
  container.querySelectorAll('.cl-member-mute-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const isMuted = btn.dataset.muted === 'true';
      btn.dataset.muted = isMuted ? 'false' : 'true';
      btn.textContent = isMuted ? '✏️ 허용' : '🔇 중지됨';
      btn.className = `btn btn-sm ${isMuted ? 'btn-secondary' : 'btn-danger-light'} cl-member-mute-btn`;
    });
  });

  // Save all
  document.getElementById('cl-members-save-all').addEventListener('click', async () => {
    const saveBtn = document.getElementById('cl-members-save-all');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';

    try {
      const boardUpdate = {};
      const nameChanges = []; // [{dId, newName}]

      container.querySelectorAll('tr[data-device-id]').forEach(row => {
        const dId = row.dataset.deviceId;
        const nameInput = row.querySelector('.cl-member-name-input');
        const groupSelect = row.querySelector('.cl-member-group-select');
        const muteBtn = row.querySelector('.cl-member-mute-btn');

        const newName = nameInput.value.trim() || members[dId]?.name || '';
        const memberData = { name: newName, muted: muteBtn.dataset.muted === 'true' };
        if (groupSelect) memberData.groupId = groupSelect.value;
        boardUpdate[`members.${dId}`] = memberData;

        // Track name changes for submission updates
        if (newName !== (members[dId]?.name || '')) {
          nameChanges.push({ dId, newName });
        }
      });

      await updateDoc(doc(db, 'boards', currentBoardCode), boardUpdate);

      // Update names in submissions
      if (nameChanges.length > 0) {
        const subs = await getDocs(collection(db, 'boards', currentBoardCode, 'submissions'));
        const updates = [];
        nameChanges.forEach(({ dId, newName }) => {
          subs.docs.filter(d => d.data().deviceId === dId).forEach(d => {
            updates.push(updateDoc(d.ref, { name: newName }));
          });
        });
        await Promise.all(updates);
      }

      toast('저장됨');
      clCloseMembersModal();
    } catch (e) {
      console.error(e);
      toast('저장 실패');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '저장';
    }
  });
}

// ══════════════════════════════════════
//  CLASSIFY: EVENT DELEGATION
// ══════════════════════════════════════

/** Setup event delegation for a classify container */
function clSetupEvents(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.addEventListener('click', (e) => {
    // Overview card click → enter workspace
    const overviewCard = e.target.closest('.cl-overview-card');
    if (overviewCard && CL.currentPage === 'overview') {
      e.stopPropagation();
      const wsId = overviewCard.dataset.wsId;
      if (wsId) clEnterWorkspace(wsId, containerId);
      return;
    }

    // Root title edit button
    const rootEditBtn = e.target.closest('.cl-root-edit-btn');
    if (rootEditBtn) {
      e.stopPropagation();
      clEditWsTitle(containerId);
      return;
    }

    // Add button (+ on tree nodes)
    const addBtn = e.target.closest('.cl-add-btn');
    if (addBtn) {
      e.stopPropagation();
      const parentId = addBtn.dataset.parent || '';
      // Show add popup at cursor position
      clShowAddPopupAt(e.clientX, e.clientY, parentId, containerId);
      return;
    }

    // Star button
    const starBtn = e.target.closest('.cl-star-btn');
    if (starBtn) { e.stopPropagation(); clToggleStar(starBtn.dataset.id); return; }

    // Menu button (three dots)
    const menuBtn = e.target.closest('.cl-node-menu-btn');
    if (menuBtn) {
      e.stopPropagation();
      e.preventDefault();
      const rect = menuBtn.getBoundingClientRect();
      clShowContextMenu(menuBtn.dataset.id, rect.right, rect.bottom);
      return;
    }

    // Folder view: edit button
    const editBtn = e.target.closest('.cl-folder-edit-btn');
    if (editBtn) {
      e.stopPropagation();
      const card = CL.cardMap[editBtn.dataset.id];
      if (card) clOpenCardEditor(card.id);
      return;
    }

    // Folder view: delete button
    const delBtn = e.target.closest('.cl-folder-del-btn');
    if (delBtn) {
      e.stopPropagation();
      clDeleteCard(delBtn.dataset.id);
      return;
    }

    // Folder navigation card (go up / back to overview)
    const navCard = e.target.closest('.cl-folder-nav');
    if (navCard && CL.currentView === 'folder') {
      e.stopPropagation();
      if (navCard.dataset.navAction === 'back-to-overview') {
        clBackToOverview(containerId);
      } else {
        CL.folderParentId = navCard.dataset.navParent || '';
        const isBoard = containerId === 'cl-board-container';
        clBuildTree();
        clRenderCurrentView(containerId);
        location.hash = clBuildHash(isBoard);
      }
      return;
    }

    // Folder card click → navigate into folder
    const folderCard = e.target.closest('.cl-folder-category');
    if (folderCard && CL.currentView === 'folder') {
      e.stopPropagation();
      CL.folderParentId = folderCard.dataset.id;
      const isBoard = containerId === 'cl-board-container';
      clBuildTree();
      clRenderCurrentView(containerId);
      location.hash = clBuildHash(isBoard);
      return;
    }

    // Breadcrumb navigation
    const breadcrumbItem = e.target.closest('.cl-breadcrumb-item');
    if (breadcrumbItem) {
      e.stopPropagation();
      CL.folderParentId = breadcrumbItem.dataset.parent || '';
      const isBoard = containerId === 'cl-board-container';
      clBuildTree();
      clRenderCurrentView(containerId);
      location.hash = clBuildHash(isBoard);
      return;
    }

  });

  // Right-click context menu on node boxes
  container.addEventListener('contextmenu', (e) => {
    const box = e.target.closest('.cl-node-box, .cl-folder-card');
    if (box && box.dataset.id) {
      const card = CL.cardMap[box.dataset.id];
      if (!card) return;
      const isMine = card.deviceId === deviceId;
      if (CL.isTeacher || isMine) {
        e.preventDefault();
        clShowContextMenu(box.dataset.id, e.clientX, e.clientY);
      }
    }
  });

  // ── Drag & Drop (tree view) ──
  container.addEventListener('dragstart', (e) => {
    const box = e.target.closest('.cl-node-box[draggable="true"]');
    if (!box || box.dataset.cardId === '__root__') { e.preventDefault(); return; }
    const cardId = box.dataset.id;
    if (!cardId) { e.preventDefault(); return; }
    CL.dragCardId = cardId;
    e.dataTransfer.setData('text/plain', cardId);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => box.classList.add('cl-dragging'), 0);
  });

  container.addEventListener('dragend', (e) => {
    const box = e.target.closest('.cl-node-box');
    if (box) box.classList.remove('cl-dragging');
    container.querySelectorAll('.cl-drag-over').forEach(el => el.classList.remove('cl-drag-over'));
    CL.dragCardId = null;
  });

  container.addEventListener('dragover', (e) => {
    if (!CL.dragCardId) return;
    const box = e.target.closest('.cl-node-box');
    if (!box) return;
    const targetId = box.dataset.id || box.dataset.cardId;
    if (!targetId || targetId === CL.dragCardId) return;
    // Only allow drop on root or category nodes
    if (targetId !== '__root__') {
      const targetCard = CL.cardMap[targetId];
      if (!targetCard || targetCard.cardType !== 'category') return;
      const descendants = clGetDescendantIds(CL.dragCardId);
      if (descendants.includes(targetId)) return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    box.classList.add('cl-drag-over');
  });

  container.addEventListener('dragleave', (e) => {
    const box = e.target.closest('.cl-node-box');
    if (box) box.classList.remove('cl-drag-over');
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!CL.dragCardId) return;
    const box = e.target.closest('.cl-node-box');
    if (!box) return;
    const targetId = box.dataset.id || box.dataset.cardId;
    if (!targetId || targetId === CL.dragCardId) return;
    // Only allow drop on root or category nodes
    if (targetId !== '__root__') {
      const targetCard = CL.cardMap[targetId];
      if (!targetCard || targetCard.cardType !== 'category') return;
    }
    const newParentId = targetId === '__root__' ? '' : targetId;
    container.querySelectorAll('.cl-drag-over').forEach(el => el.classList.remove('cl-drag-over'));
    await clMoveCard(CL.dragCardId, newParentId);
    CL.dragCardId = null;
  });
}

// Setup events for both containers
clSetupEvents('cl-gallery-container');
clSetupEvents('cl-board-container');

// Context menu event delegation (global)
document.getElementById('cl-context-menu').addEventListener('click', (e) => {
  const item = e.target.closest('.cl-ctx-item');
  if (!item || !CL.contextCardId) return;
  const action = item.dataset.action;
  const cardId = CL.contextCardId;
  clHideContextMenu();

  switch (action) {
    case 'edit':
      clOpenCardEditor(cardId);
      break;
    case 'add-category':
      clOpenCardEditor(null, cardId, 'category');
      break;
    case 'add-entry':
      clOpenCardEditor(null, cardId, 'entry');
      break;
    case 'color': {
      const box = document.querySelector(`[data-id="${cardId}"].cl-node-box, [data-id="${cardId}"].cl-folder-card`);
      if (box) {
        const rect = box.getBoundingClientRect();
        clShowColorPicker(cardId, rect.left, rect.bottom + 4);
      }
      break;
    }
    case 'move':
      clShowMoveDialog(cardId);
      break;
    case 'delete':
      clDeleteCard(cardId);
      break;
  }
});

// Color picker delegation
document.getElementById('cl-color-picker').addEventListener('click', (e) => {
  const dot = e.target.closest('.cl-color-dot');
  if (!dot || !CL.contextCardId) return;
  clSetColor(CL.contextCardId, dot.dataset.color || '');
  clHideColorPicker();
});

// Move modal delegation
document.getElementById('cl-move-list').addEventListener('click', (e) => {
  const item = e.target.closest('.cl-move-item');
  if (!item || !CL.moveCardId) return;
  clMoveCard(CL.moveCardId, item.dataset.parent || '');
  clCloseMoveModal();
});

// Close context menu / color picker / add popup on click outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('#cl-context-menu') && !e.target.closest('.cl-node-menu-btn')) {
    clHideContextMenu();
  }
  if (!e.target.closest('#cl-color-picker') && !e.target.closest('.cl-ctx-item[data-action="color"]')) {
    clHideColorPicker();
  }
  if (!e.target.closest('.cl-add-popup') && !e.target.closest('.cl-add-btn') && !e.target.closest('.cl-fab')) {
    document.querySelectorAll('.cl-add-popup').forEach(p => p.style.display = 'none');
  }
});

// ── FAB Add Button ──
window.clOpenAddPopup = function(containerId) {
  if (isBoardClosed() && !CL.isTeacher) { toast('마감된 보드입니다.'); return; }
  const popup = document.querySelector(`#${containerId}`)?.closest('.view')?.querySelector('.cl-add-popup');
  if (popup) {
    popup.style.display = popup.style.display === 'flex' ? 'none' : 'flex';
    // Reset to position near FAB
    popup.style.position = 'fixed';
    popup.style.left = '';
    popup.style.top = '';
  }
};

window.clAddFromPopup = function(type, containerId) {
  const popup = document.querySelector(`#${containerId}`)?.closest('.view')?.querySelector('.cl-add-popup');
  if (popup) popup.style.display = 'none';
  // In folder view, add under current folder; in tree view, add to root
  const parentId = CL.addPopupParentId ?? (CL.currentView === 'folder' ? CL.folderParentId : '');
  CL.addPopupParentId = undefined;
  clOpenCardEditor(null, parentId, type);
};

/** Show add popup positioned at cursor (for tree view + buttons) */
function clShowAddPopupAt(x, y, parentId, containerId) {
  if (isBoardClosed() && !CL.isTeacher) { toast('마감된 보드입니다.'); return; }
  CL.addPopupParentId = parentId;
  const popup = document.querySelector(`#${containerId}`)?.closest('.view')?.querySelector('.cl-add-popup');
  if (!popup) return;
  popup.style.display = 'flex';
  popup.style.position = 'fixed';
  popup.style.left = Math.min(x, window.innerWidth - 160) + 'px';
  popup.style.top = Math.min(y, window.innerHeight - 80) + 'px';
  popup.style.bottom = 'auto';
  popup.style.right = 'auto';
}

// ── Teacher: Add Category (toolbar button) ──
// ── Modal ↔ History (back button closes modals) ──
const MODAL_IDS = ['detail-modal', 'submit-modal', 'inquiry-submit-modal', 'classify-card-modal', 'cl-move-modal', 'cl-members-modal', 'edit-board-modal', 'change-name-modal'];

function openModalHistory() {
  history.pushState({ modal: true }, '');
}

/** Close a specific modal (or all). Handles history sync. */
window.closeModal = function(modalId) {
  const ids = modalId ? [modalId] : MODAL_IDS;
  let closed = false;
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el.style.display === 'flex') { el.style.display = 'none'; closed = true; }
  });
  if (!closed) return;
  existingFiles = null;
  teacherEditMode = false;
  // Pop modal history state, but prevent popstate from triggering full re-route
  if (history.state?.modal) {
    CL.modalClosing = true;
    history.back();
  }
};

function isAnyModalOpen() {
  return MODAL_IDS.some(id => document.getElementById(id).style.display === 'flex');
}

window.addEventListener('popstate', () => {
  // If closeModal triggered this popstate, just ignore (modal already closed)
  if (CL.modalClosing) {
    CL.modalClosing = false;
    return;
  }
  // If a modal is still open (user pressed browser back), just hide it
  if (isAnyModalOpen()) {
    MODAL_IDS.forEach(id => { document.getElementById(id).style.display = 'none'; });
    existingFiles = null;
    teacherEditMode = false;
    cleanupComments();
    return;
  }

  const activeView = document.querySelector('.view.active');
  const hash = location.hash.slice(1);

  // If classify view is active, handle sub-routing without full re-init
  if (activeView?.id === 'classify-gallery-view' && hash.startsWith('classify/')) {
    const parsed = clParseSubRoute(hash);
    if (parsed) { clApplySubRoute(parsed, 'cl-gallery-container'); return; }
  }
  if (activeView?.id === 'classify-board-view' && hash.startsWith('board/')) {
    const parsed = clParseSubRoute(hash);
    if (parsed) { clApplySubRoute(parsed, 'cl-board-container'); return; }
    // Even if sub-route parse fails, stay on classify board view (modal close case)
    return;
  }

  handleRoute();
});

// ── Init ──
window.openBoard = openBoard;
