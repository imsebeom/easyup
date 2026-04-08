# EasyUp - 과제 수합 · 탐구 질문판 · 분류하기

## 프로젝트 개요
Padlet 대안으로, 교사가 과제 보드를 만들고 학생들이 URL/텍스트/파일로 과제를 제출하는 웹앱.
탐구 질문판(inquiry) 보드 타입을 지원하여, 패들렛 Shelf 레이아웃과 유사한 열(Column) 기반 질문 관리 기능 제공.
분류하기(classify) 보드 타입은 "디지털 마인드맵 사전" 앱을 통합하여 트리+폴더 뷰 기반의 계층적 카드 관리 기능 제공.

## 기술 스택
- **프론트엔드**: Vanilla HTML/CSS/JS (빌드 도구 없음)
- **백엔드**: Firebase (Firestore + Storage + Hosting)
- **프로젝트 ID**: (firebase-config.js 참조)

## 파일 구조
- `index.html` - 메인 HTML (SPA, 모든 뷰 포함)
- `style.css` - 스타일시트
- `app.js` - Firebase 연동 및 앱 로직 (ES Module)
- `firestore.rules` - Firestore 보안 규칙
- `storage.rules` - Storage 보안 규칙
- `firebase.json` - Firebase 호스팅 설정

## 데이터 구조
- `users/{uid}` - 회원 (email, displayName, role: admin|approved|pending|rejected)
- `boards/{code}` - 보드 (type: assignment|inquiry|classify, title, description, deadline, ownerUid)
  - assignment 추가 필드: allowUrl, allowText, allowFile
  - inquiry 추가 필드: categories[]
  - classify 추가 필드: settings{groupMode}, members{deviceId: {name, groupId?}}, groups{gN: {name, color, members[]}}
- `boards/{code}/submissions/{id}` - 제출물/질문/분류카드
  - 공통: name, content, deviceId, createdAt
  - assignment 추가: type, files[], memo, title
  - inquiry 추가: category, likes, likedBy[]
  - classify 추가: cardType (category|entry), parentId, title, order, color, stars[], imageUrl, imagePath, workspaceId
- `boards/{code}/submissions/{id}/comments/{commentId}` - 댓글 (content, name, deviceId, createdAt)
- Storage: `boards/{code}/{timestamp}_{filename}`

### 질문판 카테고리
| key | icon | label | color |
|-----|------|-------|-------|
| factual | 🔍 | 사실적 질문 | #dbeafe |
| conceptual | 💡 | 개념적 질문 | #dcfce7 |
| debatable | ⚖️ | 논쟁적 질문 | #fef3c7 |
| featured | ⭐ | 이번 주 탐구 질문 | #e8d5e8 |
| resolved | ✅ | 해결된 질문 | #f1f5f9 |

학생은 factual/conceptual/debatable만 선택 가능. featured/resolved는 교사만 이동 가능.

## 배포
- **명령어**: `firebase deploy --only hosting`

## 주요 설계 결정
- **회원 승인제**: Google 로그인 후 관리자(ADMIN_EMAIL: firebase-config.js에 설정) 승인 필요
- **역할 관리**: admin(관리자) / approved(승인됨) / pending(대기) / rejected(거부)
- **학생 식별**: 로그인 없이 `deviceId` (localStorage UUID)로 본인 제출물 수정/삭제
- **교사 수정**: 교사가 학생 제출물 수정 시 원래 name/deviceId 보존 (teacherEditMode)
- **XSS 방지**: inline onclick 대신 이벤트 위임 + `data-*` 속성 사용
- **URL 안전**: `sanitizeUrl()`로 `javascript:` 프로토콜 차단
- **보드 코드**: 6자리 (30문자 알파벳, ~729M 조합), 충돌 검사 불필요
- **학생 이름 저장**: `easyup_name_{code}` (보드별 localStorage) — 기기 공유 시 보드마다 다른 이름 사용 가능
- **QR 코드 팝업**: `window.open()` 별도 브라우저 창, QRCode.js CDN 팝업 내 직접 로드, `qrPopup` 참조로 중복 창 방지
- **getJoinLink()**: 학생 접속 URL 생성 유틸리티 (4곳에서 공통 사용)
- **드래그/터치 카드 이동**: `setupTouchDrag()` 콜백 기반 유틸리티로 마우스+터치 통합. 과제 수합은 갤러리 내 순서 정렬(sortOrder), 탐구 질문판은 카테고리간 이동. 학생은 자기 카드만 factual/conceptual/debatable 범위 내 이동 가능. dragover 최적화: 이전 하이라이트 요소만 추적
- **해시 라우팅**: `handleRoute()`가 boolean 반환하여 매칭 여부 판별. `popstate` 단독 사용 (`hashchange` 미사용). 해시 패턴: `#dashboard`, `#board/CODE`, `#created/CODE`, `#join/CODE`, `#gallery/CODE`, `#inquiry/CODE`, `#classify/CODE`, `#users`
- **모달 ↔ History 연동**: 모달 열기 시 `history.pushState({modal:true})`, 뒤로가기 시 `popstate`에서 모달 닫기. `closeModal(modalId)` 유틸리티로 모든 모달 닫기 통합. popstate 핸들러 내부에서는 `history.back()` 호출 금지 (재귀 방지)
- **대시보드 디자인**: elesurvey 교사 대시보드와 동일한 디자인 시스템 적용. 카드 기반 보드 목록, sticky 헤더, 동일 너비(`btn-equal`) 액션 버튼 10개. `updateBoardField(code, field, newVal, msg)` 공통 헬퍼로 보드 필드 토글 통합
- **보드 상태 관리**: `status` 필드 (active/closed)로 마감 토글, `hidden` 필드로 숨기기. 숨긴 보드는 기본 목록에서 제외, "숨긴 보드" 토글 버튼으로 전환

## API 유틸리티 (`easyup_api.py`)
외부 스크립트/스킬에서 보드를 프로그래밍적으로 생성하는 Python 모듈.

```python
from easyup_api import create_board, create_inquiry_board, get_board, get_join_link

# 과제 수합 보드
code, link = create_board("3월 독서감상문", description="A4 1장")

# 탐구 질문판
code, link = create_inquiry_board("3단원 탐구 질문판", description="궁금한 점을 올려주세요")

# 질문 시드 데이터
from easyup_api import add_inquiry_question
add_inquiry_question(code, "학생이름", "질문 내용", category="factual")
```

CLI: `python easyup_api.py inquiry "제목" --desc "설명"`

의존성: `requests` (표준 pip). Firestore REST API 직접 호출, 추가 인증 불필요.

## 주의사항
- Firestore `where()` + `orderBy()` 복합 쿼리 → 반드시 복합 색인(`firestore.indexes.json`) 필요
- `<input type="file">` 파일 제거 후 `.value = ''` 리셋 필수 (같은 파일 재선택 불가)
- 이벤트 핸들러를 프로그래밍적으로 호출 시 `event` 객체 없음 주의

## 현재 상태
- [x] 기본 UI 구현 (교사 대시보드, 학생 갤러리 뷰, 제출 모달)
- [x] Firebase 연동 (Firestore + Storage + Auth)
- [x] 파일 업로드 (드래그앤드롭, 1GB 제한)
- [x] 실시간 제출물 표시 (onSnapshot)
- [x] URL 해시 라우팅 (전체 뷰: #dashboard, #board, #created, #join, #gallery, #inquiry, #users)
- [x] Firebase Hosting 배포 완료
- [x] XSS 방지 (이벤트 위임, URL sanitize)
- [x] deviceId 기반 본인 제출물 수정/삭제
- [x] 회원 승인제 (admin/approved/pending/rejected)
- [x] 관리자 회원관리 UI (승인/거부/이름변경)
- [x] 교사 제출물 수정 기능
- [x] 코드 정리 (openEditModal, removeSubmission, deleteBoardData 공통화)
- [x] QR 코드 팝업 (교사 대시보드/보드뷰, 별도 브라우저 창)
- [x] 보드별 학생 이름 localStorage 저장 (easyup_name_{code})
- [x] 탐구 질문판 (inquiry 보드 타입)
  - Shelf 레이아웃 (가로 스크롤, 카테고리별 열)
  - 좋아요 (deviceId 기반 중복 방지, 토글)
  - 학생 질문 작성 (텍스트만, 카테고리 선택)
  - 교사 카테고리 이동 (드롭다운)
  - 대시보드 유형 뱃지 (📋/🔬)
- [x] 교사/학생 카드 드래그·터치 이동 (setupTouchDrag 유틸리티, 마우스+터치 통합)
- [x] 전체 뷰 해시 라우팅 (뒤로가기/앞으로가기 지원, handleRoute boolean 반환)
- [x] 모달 ↔ History 연동 (뒤로가기로 모달 닫기, closeModal() 유틸리티 통합)
- [x] 교사 보드뷰와 학생 갤러리 카드 레이아웃 통합 (gallery-card 공유)
- [x] 보드 수정 기능 (제목/설명/마감일/제출방식 변경, 모달 UI, History 연동)
- [x] API 확장: 보드/제출물 CRUD (list_boards, list_submissions, update/delete, add_submission)
- [x] API 리팩터링: _update_document/_delete_document/_generate_sub_id 헬퍼 추출, 페이지네이션 추가
- [x] `/easyup` 스킬 생성 (Claude Code에서 보드 생성·관리)
- [x] 교사 대시보드 elesurvey 스타일 적용
  - 디자인 시스템: #4A90D9 블루, Pretendard, 그레이스케일 체계, sticky 헤더
  - 테이블 → 카드 레이아웃, 드롭다운 정렬, 로딩 스피너
  - 보드 카드 10개 버튼: 교사공유/학생공유/QR/미리보기/편집/결과/마감/복제/숨기기/삭제
  - 새 보드 필드: `status` (active/closed), `hidden` (boolean)
  - `updateBoardField()` 공통 헬퍼, `getTeacherLink()` 유틸리티
- [x] 학생 이름변경 모달 (뷰 전환 → 모달, 해시 라우터 충돌 해결)
- [x] 초기 로딩 화면 (loading-view 스피너, 학생 라우트 즉시 처리로 로그인 깜빡임 제거)
- [x] closeModal window 노출 (ES Module 스코프 수정)
- [x] GitHub 공개 레포 (imsebeom/easyup)
  - API 키/개인정보를 firebase-config.js + .env로 분리 (.gitignore)
  - git-filter-repo로 히스토리에서 키 완전 제거
  - firebase-config.example.js 템플릿 제공
- [x] 제출 유형 UI 변경 (탭 버튼 → 라디오 버튼)
- [x] 주간 교사별 사용량/비용 보고서 (Cloud Functions)
  - `functions/index.js`: weeklyUsageReport (매주 월 09:00 KST) + testUsageReport (HTTP)
  - Firestore 데이터에서 교사별 보드/제출물/파일용량 집계, 비용 추정
  - Gmail SMTP로 HTML 보고서 이메일 발송
  - Secrets: GMAIL_APP_PASSWORD, REPORT_EMAIL, GMAIL_SENDER (Firebase Secret Manager)
  - 테스트 URL: https://us-central1-easyup-1604e.cloudfunctions.net/testUsageReport
- [x] easyup_api.py 확장: list_users(), list_all_boards() 추가
- [x] 이미지/영상 파일 임베드 (카드 썸네일 + 상세 모달 인라인 표시)
  - `getMediaType()` 확장자 감지 (IMAGE_EXTS, VIDEO_EXTS)
  - `renderFileLinksHtml()` → img/video 태그 렌더링
  - `renderFileThumbnailHtml()` → 갤러리 카드 첫 이미지 썸네일
- [x] 제출물 넘겨보기 (상세 모달)
  - ← → 네비 버튼, 키보드 ArrowLeft/Right, 터치 스와이프
  - `galleryDocs` 캐시로 Firestore 재요청 없이 탐색
  - `navigateDetail(direction)` + 모달 내 네비 시 history 중복 push 방지
- [x] 학생 댓글 기능
  - 서브컬렉션: `boards/{code}/submissions/{id}/comments/{commentId}`
  - 실시간 onSnapshot, deviceId 기반 본인 표시
  - Enter 키 제출, Shift+Enter 줄바꿈
  - 댓글 수정/삭제 (본인 댓글 + 교사는 전체)
  - 수정 이력: `editHistory[]` 배열로 추적 (교사만 열람)
  - 소프트 삭제: `deleted/deletedAt/deletedBy` (교사만 원문 열람, 학생은 안 보임)
  - 카드에 댓글 수 뱃지 표시 (`loadCommentCounts`)
  - Firestore rules: 댓글 create/read는 보드 open 또는 교사만, update/delete도 동일
- [x] Firestore rules 강화
  - `isOwner()` / `isBoardOpen()` 헬퍼 함수
  - submissions: open 보드 또는 교사만 CRUD, private 보드는 교사만 read
  - comments: 동일 정책 적용
  - boards: 인증 사용자만 create, 소유자만 update/delete
- [x] 마감일 초과 제출 차단 (클라이언트 `isBoardClosed()` + rules `status` 기반)
- [x] 보드 상태 3단계 순환: active → closed(마감) → private(비공개) → active(재시작)
  - 비공개: 학생 접근 완전 차단 (`private-view` 🔒 화면)
  - 재시작 시 deadline 자동 제거
- [x] 분류하기(classify) 보드 타입 — 트리+폴더 뷰 (v2, 마인드맵 사전 통합)
  - 트리 뷰: SVG curved 연결선, 계층적 노드 표시, 카테고리/엔트리 구분
  - 폴더 뷰: 브레드크럼 네비게이션, 카드 그리드, 폴더 진입/탐색
  - 책 뷰: 풀스크린 사전 프레젠테이션 (표지 → 목차 → 챕터/카드)
    - 표지: 보드 제목, 워크스페이스 이름, 참여자 이름 목록, 통계
    - 목차: 전체 분류 계층 표시, 클릭 시 해당 페이지 점프
    - 좌우 각각 한 쪽, 한 쪽마다 카드 하나씩
    - 최상위 분류: 왼쪽 빈 페이지 + 오른쪽 Chapter 간지
    - 하위 분류: 한 쪽 페이지, depth별 점진 축소 (제목/바/라벨)
    - 카드: 사전 항목 스타일, 상단 분류 경로 브레드크럼
    - 카드: 이미지+텍스트 한 쪽 통합, 이미지 flex:2 확대, 설명 세로 가운데
    - 쪽번호: 모든 페이지 우하단 표시
    - 키보드 ←→, 터치 스와이프, ESC 닫기, 페이지 넘기기 애니메이션
    - A5 비율(148:210) aspect-ratio로 인쇄물과 일관된 경험
    - 인쇄: HTML 새 창 방식 (html2canvas/jsPDF 제거)
      - 일반 인쇄: 세로 모드, 한 쪽 한 페이지
      - 소책자 인쇄: 가로 모드, 표준 booklet imposition (2쪽 모아찍기)
      - 플로팅 인쇄/닫기 버튼, @media print 숨김
      - 브라우저 Ctrl+P로 직접 인쇄 또는 PDF 저장
  - 뷰 토글: 트리 ↔ 폴더 ↔ 책 내부 전환 (해시 라우터 충돌 없음)
  - 카드 CRUD: 제목/설명/이미지 입력 모달, 카테고리·엔트리 타입
  - 이미지 업로드: Firebase Storage, 드래그앤드롭 지원
  - 추천(stars): deviceId 기반 토글, 배열로 저장
  - 컨텍스트 메뉴: 우클릭/⋮ 버튼, 수정/삭제/이동/색상변경/하위추가
  - 색상 피커: 10색 팔레트, 노드 왼쪽 보더 색상
  - 카드 이동: 모달에서 대상 카테고리 선택, 하위 이동 방지
  - 검색: 실시간 필터링, 조상 노드 자동 포함, 하이라이트
  - CL 상태 객체: allCards/cards/tree/cardMap/currentView/currentPage/workspaceId/searchQuery/folderParentId
  - `cl-` CSS 접두사로 기존 스타일 충돌 방지
  - 교사/학생 동일 뷰, 교사는 추가 컨트롤(모든 카드 수정/삭제)
  - 보드 생성 시 카테고리 → submissions에 cardType='category'로 저장
  - 보드 복제 시 카테고리도 함께 복제
  - 해시 라우팅: `#classify/CODE` (학생), `#board/CODE` (교사)
- [x] 분류하기 보드: 개인/모둠 모드 + 개요 페이지 + 워크스페이스 분리
  - 보드 생성 시 개인별/모둠형 선택, 모둠 수 설정
  - `settings.groupMode` (individual|team), `groups` (모둠 목록), `members` (참여자)
  - 개요 페이지: 참여자/모둠 카드 그리드, 카드 수 표시
  - 워크스페이스 진입: 개요에서 클릭 → 해당 워크스페이스 카드만 필터링
  - `workspaceId` 필드: 카드 생성 시 현재 워크스페이스 ID 저장
  - 루트 노드: 트리 뷰 최상단에 워크스페이스 커스텀 제목(wsTitle) + 항목 수 표시, 학생 편집 가능
  - 인라인 + 버튼: 루트/카테고리 노드 hover 시 + 버튼, 클릭 시 팝업 메뉴
  - FAB 분리: 폴더 뷰에서만 동적 FAB 생성, 트리 뷰/개요에서는 숨김
  - 뒤로가기 버튼: 워크스페이스 → 개요 이동
  - 학생 이름 입력 시 모둠 선택 드롭다운 (team 모드)
  - 참여 코드 뱃지 (학생 뷰, 클릭 복사)
  - 멤버 수 뱃지 (실시간 업데이트)
  - board doc onSnapshot으로 멤버 실시간 동기화
- [ ] 모바일 반응형 테스트
