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

/** Check if the current board is closed (by status or deadline) */
function isBoardClosed() {
  if (!currentBoard) return false;
  if (currentBoard.status === 'closed') return true;
  if (currentBoard.deadline && new Date() > new Date(currentBoard.deadline)) return true;
  return false;
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
  const firstImage = files.find(f => getMediaType(f.name) === 'image');
  const firstVideo = files.find(f => getMediaType(f.name) === 'video');
  let thumb = '';
  if (firstImage) {
    thumb = `<div class="card-thumbnail"><img src="${escapeHtml(firstImage.url)}" alt="" loading="lazy"></div>`;
  } else if (firstVideo) {
    thumb = `<div class="card-thumbnail"><video src="${escapeHtml(firstVideo.url)}" preload="metadata" muted></video><div class="card-thumbnail-badge">▶ 영상</div></div>`;
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
  return `${location.origin}${location.pathname}#join/${code}`;
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
let galleryDocs = [];
let currentDetailIndex = -1;
let unsubscribeComments = null;

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
  if (hash.startsWith('join/') || hash.startsWith('gallery/') || hash.startsWith('inquiry/')) {
    handleStudentRoute(hash.split('/')[1].toUpperCase());
  }
})();

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  const hash = location.hash.slice(1);

  // Student route: already handled by earlyStudentRoute or popstate
  if (hash.startsWith('join/') || hash.startsWith('gallery/') || hash.startsWith('inquiry/')) {
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

    // Sort: pending first, then by date
    users.sort((a, b) => {
      const order = { pending: 0, approved: 1, admin: 2, rejected: 3 };
      if (order[a.role] !== order[b.role]) return order[a.role] - order[b.role];
      return (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0);
    });

    if (!users.length) {
      container.innerHTML = '<div class="empty-state">등록된 회원이 없습니다</div>';
      return;
    }

    container.innerHTML = users.map(u => {
      const date = u.createdAt ? new Date(u.createdAt.toMillis()).toLocaleDateString('ko-KR') : '';
      const isSelf = u.uid === currentUser.uid;

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

      return `<div class="user-card">
        <div class="user-info">
          <span class="user-info-name" data-uid="${escapeHtml(u.uid)}">${escapeHtml(u.displayName || '(이름 없음)')}</span>
          <button class="btn-edit-name" data-uid="${escapeHtml(u.uid)}" data-name="${escapeHtml(u.displayName || '')}" title="이름 수정">✏️</button>
          <span class="user-info-email">${escapeHtml(u.email)}</span>
          <span class="user-info-date">${date}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="user-status ${ROLE_CLS[u.role] || ''}">${ROLE_LABEL[u.role] || u.role}</span>
          <div class="user-actions">${actions}</div>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    console.error(e);
    container.innerHTML = '<div class="empty-state">불러오기 실패</div>';
  }
}

/** Helper: update user field and reload list */
async function updateUser(uid, data, msg) {
  try {
    await updateDoc(doc(db, 'users', uid), data);
    toast(msg);
    loadUsers();
  } catch (e) { toast('처리 실패'); }
}

// Event delegation for user management
document.getElementById('users-list').addEventListener('click', (e) => {
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
  // Student routes (no auth needed)
  if (hash.startsWith('join/') || hash.startsWith('gallery/') || hash.startsWith('inquiry/')) {
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

async function handleStudentRoute(code) {
  try {
    const boardDoc = await getDoc(doc(db, 'boards', code));
    if (!boardDoc.exists()) { toast('존재하지 않는 코드입니다'); return; }
    currentBoard = boardDoc.data();
    currentBoard.code = code;
    currentBoardCode = code;

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
  showView('name-view');
  location.hash = `join/${currentBoardCode}`;
  setTimeout(() => document.getElementById('student-name-input').focus(), 100);
}

window.enterBoard = function() {
  const name = document.getElementById('student-name-input').value.trim();
  if (!name) { toast('이름을 입력하세요'); return; }
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

window.saveChangedName = function() {
  const name = document.getElementById('change-name-input').value.trim();
  if (!name) { toast('이름을 입력하세요'); return; }
  studentName = name;
  localStorage.setItem(`easyup_name_${currentBoardCode}`, name);
  document.getElementById('gallery-student-name').textContent = name;
  document.getElementById('inquiry-gallery-student-name').textContent = name;
  closeModal('change-name-modal');
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
}

function renderGallery(docs) {
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
  if (unsubscribeComments) { unsubscribeComments(); unsubscribeComments = null; }
  openDetail(galleryDocs[newIndex].id);
}

// Navigation buttons
document.getElementById('detail-prev').addEventListener('click', () => navigateDetail(-1));
document.getElementById('detail-next').addEventListener('click', () => navigateDetail(1));

// Keyboard navigation (ArrowLeft/Right)
document.addEventListener('keydown', (e) => {
  if (document.getElementById('detail-modal').style.display !== 'flex') return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') navigateDetail(-1);
  if (e.key === 'ArrowRight') navigateDetail(1);
});

// Touch swipe navigation on detail modal
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

window.closeDetailModal = function() {
  if (unsubscribeComments) { unsubscribeComments(); unsubscribeComments = null; }
  closeModal('detail-modal');
};

// ── Comments ──
async function loadCommentCounts(submissionIds) {
  const code = currentBoardCode;
  for (const id of submissionIds) {
    const el = document.querySelector(`.card-comment-count[data-sub-id="${id}"]`);
    if (!el) continue;
    try {
      const snap = await getDocs(collection(db, 'boards', code, 'submissions', id, 'comments'));
      const count = snap.docs.filter(d => !d.data().deleted).length;
      el.innerHTML = count > 0 ? `<span class="card-comment-badge">💬 ${count}</span>` : '';
    } catch (_) {}
  }
}

function isCurrentBoardTeacher() {
  return currentUser && currentBoard && currentBoard.ownerUid === currentUser.uid;
}

function setupCommentsListener(submissionId) {
  if (unsubscribeComments) { unsubscribeComments(); unsubscribeComments = null; }
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
    const editHistory = old.editHistory || [];
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
    const isExpired = !isClosed && b.deadline && new Date() > new Date(b.deadline);
    const typeBadge = b.type === 'inquiry' ? '🔬 질문판' : '📋 과제';
    let statusBadge;
    if (isClosed) statusBadge = '<span class="badge badge-expired">마감</span>';
    else if (isExpired) statusBadge = '<span class="badge badge-expired">기한초과</span>';
    else statusBadge = '<span class="badge badge-active">진행중</span>';

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
        <button class="btn btn-sm btn-danger-light btn-equal btn-toggle-status" data-code="${escapeHtml(b.code)}">${isClosed ? '시작' : '마감'}</button>
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

function toggleBoardStatus(code) {
  const board = allBoards.find(b => b.code === code);
  if (!board) return;
  const newStatus = board.status === 'closed' ? 'active' : 'closed';
  updateBoardField(code, 'status', newStatus, newStatus === 'closed' ? '마감됨' : '다시 시작됨', '상태 변경 실패');
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
    createdAt: serverTimestamp()
  };
  if (board.type === 'assignment') {
    Object.assign(boardData, { allowUrl: board.allowUrl ?? true, allowText: board.allowText ?? true, allowFile: board.allowFile ?? true });
  } else {
    boardData.categories = board.categories || Object.keys(INQUIRY_CATEGORIES);
  }
  try {
    await setDoc(doc(db, 'boards', newCode), boardData);
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
  // Update placeholder
  const titleInput = document.getElementById('board-title');
  titleInput.placeholder = type === 'inquiry' ? '예: 3단원 탐구 질문' : '예: 3월 독서감상문';
};

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
    createdAt: serverTimestamp()
  };

  if (selectedBoardType === 'assignment') {
    const allowUrl = document.getElementById('allow-url').checked;
    const allowText = document.getElementById('allow-text').checked;
    const allowFile = document.getElementById('allow-file').checked;
    if (!allowUrl && !allowText && !allowFile) { toast('최소 하나의 제출 방식을 선택하세요'); return; }
    Object.assign(boardData, { allowUrl, allowText, allowFile });
  } else {
    boardData.categories = Object.keys(INQUIRY_CATEGORIES);
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

    document.getElementById('board-title-display').textContent = currentBoard.title;
    document.getElementById('board-code-badge').textContent = `코드: ${code}`;
    setTextVisibility('board-desc-display', currentBoard.description);

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

  const isAssignment = currentBoard.type !== 'inquiry';
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

  if (currentBoard.type !== 'inquiry') {
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
  unsubscribeInquiryGallery = onSnapshot(
    query(collection(db, 'boards', currentBoardCode, 'submissions'), orderBy('createdAt', 'desc')),
    (snapshot) => renderInquiryShelf(snapshot.docs, 'inquiry-gallery-shelf', false)
  );
}

function renderInquiryShelf(docs, containerId, isTeacher) {
  const container = document.getElementById(containerId);
  const categories = currentBoard.categories || Object.keys(INQUIRY_CATEGORIES);

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

  showView('inquiry-board-view');
  location.hash = `board/${code}`;

  if (unsubscribeInquiryBoard) unsubscribeInquiryBoard();
  unsubscribeInquiryBoard = onSnapshot(
    query(collection(db, 'boards', code, 'submissions'), orderBy('createdAt', 'desc')),
    (snap) => renderInquiryShelf(snap.docs, 'inquiry-board-shelf', true)
  );
}

// ── Modal ↔ History (back button closes modals) ──
const MODAL_IDS = ['detail-modal', 'submit-modal', 'inquiry-submit-modal', 'edit-board-modal', 'change-name-modal'];

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
  if (history.state?.modal) history.back();
};

function isAnyModalOpen() {
  return MODAL_IDS.some(id => document.getElementById(id).style.display === 'flex');
}

window.addEventListener('popstate', () => {
  if (isAnyModalOpen()) {
    // popstate already popped the modal state — just hide modals, don't call history.back()
    MODAL_IDS.forEach(id => { document.getElementById(id).style.display = 'none'; });
    existingFiles = null;
    teacherEditMode = false;
    if (unsubscribeComments) { unsubscribeComments(); unsubscribeComments = null; }
    return;
  }
  handleRoute();
});

// ── Init ──
window.openBoard = openBoard;
