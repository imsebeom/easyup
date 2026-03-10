import { initializeApp } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js";
import { getFirestore, collection, doc, setDoc, getDoc, getDocs, deleteDoc, updateDoc, onSnapshot, query, orderBy, serverTimestamp, where, getCountFromServer } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";
import { getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-storage.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "REDACTED_API_KEY",
  authDomain: "easyup-1604e.firebaseapp.com",
  projectId: "easyup-1604e",
  storageBucket: "easyup-1604e.firebasestorage.app",
  messagingSenderId: "512845556710",
  appId: "1:512845556710:web:1b99a924dac0f1e6d10427",
  measurementId: "G-B660Z633QD"
};

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

/** Set text and show/hide element */
function setTextVisibility(elementId, text) {
  const el = document.getElementById(elementId);
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
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

/** Render file links HTML */
function renderFileLinksHtml(files) {
  if (!files?.length) return '';
  return '<div class="submission-files">' +
    files.map(f => `<a class="file-link" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">📄 ${escapeHtml(f.name)} (${formatSize(f.size)})</a>`).join('') +
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
let editingSubmissionId = null;
let existingFiles = null;
let studentName = '';
let teacherEditMode = false; // true when teacher edits from board-view

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
  if (unsubscribe && viewId !== 'board-view') { unsubscribe(); unsubscribe = null; }
  if (unsubscribeGallery && viewId !== 'gallery-view') { unsubscribeGallery(); unsubscribeGallery = null; }
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

const ADMIN_EMAIL = 'hccgahy1@gmail.com';

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

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  const hash = location.hash.slice(1);

  // Student route: no auth needed
  if (hash.startsWith('join/')) {
    handleStudentRoute(hash.split('/')[1].toUpperCase());
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

  if (hash.startsWith('board/')) {
    openBoard(hash.split('/')[1].toUpperCase());
  } else {
    showView('dashboard-view');
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
function handleRoute() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('join/')) {
    handleStudentRoute(hash.split('/')[1].toUpperCase());
  } else if (hash.startsWith('board/') && currentUser) {
    openBoard(hash.split('/')[1].toUpperCase());
  }
}

async function handleStudentRoute(code) {
  try {
    const boardDoc = await getDoc(doc(db, 'boards', code));
    if (!boardDoc.exists()) { toast('존재하지 않는 코드입니다'); return; }
    currentBoard = boardDoc.data();
    currentBoard.code = code;
    currentBoardCode = code;

    const savedName = localStorage.getItem('easyup_name');
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
  setTimeout(() => document.getElementById('student-name-input').focus(), 100);
}

window.enterBoard = function() {
  const name = document.getElementById('student-name-input').value.trim();
  if (!name) { toast('이름을 입력하세요'); return; }
  studentName = name;
  localStorage.setItem('easyup_name', name);
  showGallery();
};

document.getElementById('student-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enterBoard();
});

window.changeStudentName = function() { showNameView(); };

// ══════════════════════════════════════
//  STUDENT: GALLERY BOARD
// ══════════════════════════════════════
function showGallery() {
  document.getElementById('gallery-title').textContent = currentBoard.title;
  setTextVisibility('gallery-desc', currentBoard.description);
  document.getElementById('gallery-student-name').textContent = studentName;
  renderDeadline('gallery-deadline', currentBoard.deadline);

  showView('gallery-view');

  if (unsubscribeGallery) unsubscribeGallery();
  unsubscribeGallery = onSnapshot(submissionsQuery(currentBoardCode), (snapshot) => {
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
      preview = '<div class="card-files">' +
        data.files.slice(0, 3).map(f => `<span class="card-file-chip">📄 ${escapeHtml(truncate(f.name, 20))}</span>`).join('') +
        (data.files.length > 3 ? `<span class="card-file-more">+${data.files.length - 3}개</span>` : '') +
        '</div>';
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
        <div class="card-footer">
          <span class="card-author">${escapeHtml(data.name)}</span>
          <span class="card-time">${time}${updated}</span>
        </div>
        ${isMine ? `
          <div class="card-actions">
            <button class="btn-icon btn-edit" data-id="${escapeHtml(d.id)}" title="수정">✏️</button>
            <button class="btn-icon btn-icon-danger btn-del" data-id="${escapeHtml(d.id)}" title="삭제">🗑</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
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
    const subDoc = await getDoc(doc(db, 'boards', currentBoardCode, 'submissions', submissionId));
    if (!subDoc.exists()) return;
    const data = subDoc.data();

    document.getElementById('detail-title').textContent = data.title || '(제목 없음)';

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

    document.getElementById('detail-body').innerHTML = html;
    document.getElementById('detail-modal').style.display = 'flex';
  } catch (e) {
    console.error(e);
  }
}

window.closeDetailModal = function() {
  document.getElementById('detail-modal').style.display = 'none';
};

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
  resetSubmitForm();
  document.getElementById('submit-modal-title').textContent = '과제 제출';
  setupTabs();
  document.getElementById('submit-modal').style.display = 'flex';
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
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
    btn.textContent = TYPE_CONFIG[t].label;
    btn.onclick = () => selectTab(t);
    tabs.appendChild(btn);
  });

  if (types.length > 0) selectTab(types[0]);
}

window.closeSubmitModal = function() {
  document.getElementById('submit-modal').style.display = 'none';
  existingFiles = null;
  teacherEditMode = false;
};

function selectTab(type) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.textContent === TYPE_CONFIG[type].label);
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
}

async function editMySubmission(submissionId) {
  try {
    const subDoc = await getDoc(doc(db, 'boards', currentBoardCode, 'submissions', submissionId));
    if (!subDoc.exists()) return;
    const data = subDoc.data();
    if (data.deviceId !== deviceId) { toast('수정 권한이 없습니다'); return; }
    openEditModal(submissionId, data, false);
  } catch (e) { console.error(e); }
}

async function removeSubmission(id, { checkOwnership = false } = {}) {
  if (!confirm('삭제하시겠습니까?')) return;
  try {
    const sub = await getDoc(doc(db, 'boards', currentBoardCode, 'submissions', id));
    if (sub.exists()) {
      if (checkOwnership && sub.data().deviceId !== deviceId) { toast('삭제 권한이 없습니다'); return; }
      await deleteStorageFiles(sub.data().files);
    }
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
  container.innerHTML = '<div class="empty-state">로딩 중...</div>';
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
  const search = (document.getElementById('search-boards')?.value || '').trim().toLowerCase();
  let filtered = allBoards;
  if (search) filtered = allBoards.filter(b => b.title.toLowerCase().includes(search) || b.code.toLowerCase().includes(search));

  filtered.sort((a, b) => {
    if (currentSort === 'title') return currentSortDir === 'asc' ? a.title.localeCompare(b.title, 'ko') : b.title.localeCompare(a.title, 'ko');
    if (currentSort === 'submissions') return currentSortDir === 'desc' ? b.submissionCount - a.submissionCount : a.submissionCount - b.submissionCount;
    return currentSortDir === 'desc' ? b.createdAtMs - a.createdAtMs : a.createdAtMs - b.createdAtMs;
  });

  if (!filtered.length) {
    container.innerHTML = search
      ? '<div class="empty-state">검색 결과가 없습니다</div>'
      : '<div class="empty-state">아직 만든 과제 보드가 없습니다.<br>"새 과제 보드" 버튼을 눌러 시작하세요.</div>';
    return;
  }

  container.innerHTML = `<table class="board-table"><thead><tr>
    <th>과제 제목</th><th class="col-code">코드</th><th class="col-count">제출</th>
    <th class="col-deadline">마감일</th><th class="col-date">생성일</th><th class="col-actions">관리</th>
  </tr></thead><tbody>${filtered.map(b => {
    const created = b.createdAtMs ? new Date(b.createdAtMs).toLocaleDateString('ko-KR') : '-';
    let dlText = '-', dlClass = '';
    if (b.deadline) {
      const dl = new Date(b.deadline);
      dlText = dl.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
      if (new Date() > dl) dlClass = 'expired-text';
    }
    return `<tr class="board-row" data-code="${escapeHtml(b.code)}">
      <td class="board-title-cell"><strong>${escapeHtml(b.title)}</strong>
        ${b.description ? `<span class="board-desc-preview">${escapeHtml(truncate(b.description, 40))}</span>` : ''}</td>
      <td class="col-code"><span class="code-chip">${escapeHtml(b.code)}</span></td>
      <td class="col-count"><span class="count-chip">${b.submissionCount}</span></td>
      <td class="col-deadline ${dlClass}">${dlText}</td>
      <td class="col-date">${created}</td>
      <td class="col-actions">
        <button class="btn-icon btn-copy-link" data-code="${escapeHtml(b.code)}" title="링크 복사">🔗</button>
        <button class="btn-icon btn-icon-danger btn-del-board" data-code="${escapeHtml(b.code)}" data-title="${escapeHtml(b.title)}" title="삭제">🗑</button>
      </td></tr>`;
  }).join('')}</tbody></table>`;
}

// Event delegation for dashboard table (XSS-safe)
document.getElementById('dashboard-boards').addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.btn-copy-link');
  if (copyBtn) { e.stopPropagation(); copyJoinLink(copyBtn.dataset.code); return; }

  const delBtn = e.target.closest('.btn-del-board');
  if (delBtn) { e.stopPropagation(); deleteBoardFromList(delBtn.dataset.code, delBtn.dataset.title); return; }

  const row = e.target.closest('.board-row');
  if (row?.dataset.code) openBoard(row.dataset.code);
});

window.filterBoards = () => renderDashboard();
window.sortBoards = function(field) {
  if (currentSort === field) currentSortDir = currentSortDir === 'desc' ? 'asc' : 'desc';
  else { currentSort = field; currentSortDir = field === 'title' ? 'asc' : 'desc'; }
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.sort-btn[data-sort="${field}"]`).classList.add('active');
  renderDashboard();
};

function copyJoinLink(code) {
  navigator.clipboard.writeText(`${location.origin}${location.pathname}#join/${code}`);
  toast('학생 참여 링크 복사됨');
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
  if (!confirm(`"${title}" 보드를 삭제하시겠습니까?`)) return;
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

window.createBoard = async function() {
  if (!currentUser) return;
  const title = document.getElementById('board-title').value.trim();
  if (!title) { toast('과제 제목을 입력하세요'); return; }
  const desc = document.getElementById('board-desc').value.trim();
  const deadline = document.getElementById('board-deadline').value;
  const allowUrl = document.getElementById('allow-url').checked;
  const allowText = document.getElementById('allow-text').checked;
  const allowFile = document.getElementById('allow-file').checked;
  if (!allowUrl && !allowText && !allowFile) { toast('최소 하나의 제출 방식을 선택하세요'); return; }

  // 6-char code from 30-char alphabet = 729M combinations, collision negligible
  const code = generateCode();

  try {
    await setDoc(doc(db, 'boards', code), {
      title, description: desc, deadline: deadline || null, allowUrl, allowText, allowFile,
      code, ownerUid: currentUser.uid, ownerName: currentUser.displayName || currentUser.email, createdAt: serverTimestamp()
    });
    currentBoardCode = code;
    document.getElementById('created-code').textContent = code;
    showView('created-view');
    toast('보드 생성 완료!');
  } catch (e) { toast('오류: ' + e.message); }
};

window.copyCode = () => { navigator.clipboard.writeText(currentBoardCode); toast('코드 복사됨'); };
window.copyLink = () => { navigator.clipboard.writeText(`${location.origin}${location.pathname}#join/${currentBoardCode}`); toast('링크 복사됨'); };
window.goToBoard = () => openBoard(currentBoardCode);
window.backToDashboard = () => { showView('dashboard-view'); location.hash = ''; loadMyBoards(); };

window.copyBoardLink = () => {
  navigator.clipboard.writeText(`${location.origin}${location.pathname}#join/${currentBoard.code}`);
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

    document.getElementById('board-title-display').textContent = currentBoard.title;
    document.getElementById('board-code-badge').textContent = `코드: ${code}`;
    setTextVisibility('board-desc-display', currentBoard.description);

    showView('board-view');
    location.hash = `board/${code}`;

    if (unsubscribe) unsubscribe();
    unsubscribe = onSnapshot(submissionsQuery(code), (snap) => renderSubmissions(snap.docs));
  } catch (e) { toast('오류 발생'); }
}

function renderSubmissions(docs) {
  const list = document.getElementById('submissions-list');
  document.getElementById('submission-count').textContent = `총 ${docs.length}건`;
  if (!docs.length) { list.innerHTML = '<div class="empty-state">아직 제출물이 없습니다</div>'; return; }

  list.innerHTML = docs.map(d => {
    const data = d.data();
    const time = data.createdAt ? formatDate(data.createdAt.toDate()) : '';
    const cfg = TYPE_CONFIG[data.type] || {};
    const updated = data.updatedAt ? ' (수정됨)' : '';

    let contentHtml = '';
    if (data.type === 'url') {
      const safeUrl = escapeHtml(sanitizeUrl(data.content));
      contentHtml = `<div class="submission-content"><a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a></div>`;
    } else if (data.type === 'text') {
      contentHtml = `<div class="submission-content">${escapeHtml(data.content)}</div>`;
    }

    return `<div class="submission-card" data-id="${escapeHtml(d.id)}">
      <div class="submission-header">
        <div><span class="submission-name">${escapeHtml(data.name)}</span><span class="submission-type ${cfg.cls || ''}">${cfg.label || ''}</span></div>
        <span class="submission-time">${time}${updated}</span>
      </div>
      ${data.title ? `<div class="submission-title-text">${escapeHtml(data.title)}</div>` : ''}
      ${contentHtml}
      ${renderFileLinksHtml(data.files)}
      ${data.memo ? `<div class="submission-memo">💬 ${escapeHtml(data.memo)}</div>` : ''}
      <div class="submission-actions">
        <button class="btn-edit-submission btn-edit-sub" data-id="${escapeHtml(d.id)}">수정</button>
        <button class="btn-delete-submission btn-del-sub" data-id="${escapeHtml(d.id)}">삭제</button>
      </div>
    </div>`;
  }).join('');
}

// Event delegation for teacher submissions
document.getElementById('submissions-list').addEventListener('click', (e) => {
  const editBtn = e.target.closest('.btn-edit-sub');
  if (editBtn) { teacherEditSubmission(editBtn.dataset.id); return; }

  const btn = e.target.closest('.btn-del-sub');
  if (btn) removeSubmission(btn.dataset.id);
});

async function teacherEditSubmission(submissionId) {
  try {
    const subDoc = await getDoc(doc(db, 'boards', currentBoardCode, 'submissions', submissionId));
    if (!subDoc.exists()) return;
    openEditModal(submissionId, subDoc.data(), true);
  } catch (e) { console.error(e); toast('수정 오류'); }
}

window.deleteBoard = async function() {
  if (!confirm(`"${currentBoard.title}" 보드를 삭제하시겠습니까?`)) return;
  try {
    await deleteBoardData(currentBoardCode);
    toast('삭제됨');
    backToDashboard();
  } catch (e) { toast('삭제 실패'); }
};

window.downloadAll = function() {
  const cards = document.querySelectorAll('.submission-card');
  let text = `${currentBoard.title} - 제출물 목록\n${'='.repeat(50)}\n\n`;
  cards.forEach(card => {
    const name = card.querySelector('.submission-name')?.textContent || '';
    const time = card.querySelector('.submission-time')?.textContent || '';
    const type = card.querySelector('.submission-type')?.textContent || '';
    const titleEl = card.querySelector('.submission-title-text');
    const content = card.querySelector('.submission-content');
    const files = card.querySelectorAll('.file-link');
    const memo = card.querySelector('.submission-memo');
    text += `이름: ${name}\n시간: ${time}\n유형: ${type}\n`;
    if (titleEl) text += `제목: ${titleEl.textContent}\n`;
    if (content) text += `내용: ${content.textContent}\n`;
    files.forEach(f => text += `파일: ${f.textContent} - ${f.href}\n`);
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

// ── Init ──
window.openBoard = openBoard;
window.addEventListener('hashchange', handleRoute);
