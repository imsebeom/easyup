# EleUp (엘리업)

초등 교실용 과제·질문·분류·클래스 관리 웹앱. Padlet 대안으로, 교사가 보드를 만들고 학생은 로그인 없이 참여합니다.

## 주요 기능

### 보드 3종
- **📋 과제 수합** — URL / 텍스트 / 파일 제출, 이미지·영상 썸네일, 상세 모달 스와이프 탐색, 댓글
- **🔬 탐구 질문판** — 사실적 / 개념적 / 논쟁적 등 카테고리별 Shelf, 좋아요, 드래그 이동, 교사 전용 `⭐ 이번 주 탐구 / ✅ 해결됨`
- **🗂 분류하기** — 트리 / 폴더 / 책 3가지 뷰, 개인·모둠 모드, 이미지 카드, 읽기 전용 공개 QR 링크(`#book/CODE/WS`) 및 책자 인쇄

### 클래스 (주간 캘린더)
- alias 기반 짧은 경로(`/<alias>`)로 학생 공개 뷰
- 교사가 주간 그리드에 보드 배치(드래그&드롭, 날짜 피커, 외부 URL 게시)
- 슬롯 학생 노출 숨기기(👁/🚫), 테이블 모드(모든 주차 한눈에)

### 실시간 채팅 (과제 보드 · 클래스 모두)
- **전체 채팅**: 늦게 접속해도 전체 기록 로드, URL 자동 하이퍼링크
- **교사 귓말(DM)**: 접속만 한 학생에게도 가능 (presence 기반)
- **교사 🔓/🔒**: 전체 채팅 on/off, DM은 항상 유지
- **교사 파일 첨부(≤100MB)**: 📎 버튼, 드래그&드롭, 클립보드 붙여넣기 — 이미지/영상은 인라인 미리보기
- 미확인 개수 배지 + pulse 애니메이션, 오늘 메시지는 `HH:mm`, 이전은 `M/D HH:mm`

### 관리
- 교사 대시보드: 보드 10개 기능 버튼(공유·QR·편집·복제·숨김·삭제 등), 레이아웃 고정 + 스크롤
- **교사 회원 승인제**: Google 로그인 후 관리자 승인 필요 (`admin / approved / pending / rejected`), 회원탈퇴 지원
- **학생 접속**: 로그인 없이 닉네임 입력만으로 참여 (localStorage의 deviceId로 본인 제출물·카드 식별)
- 사용량 추적(보드 수 · 제출물 · Storage), 주간 비용 리포트 Cloud Function

## 기술 스택

- **프론트엔드**: Vanilla HTML/CSS/JS (ES Module), 빌드 도구 없음
- **백엔드**: Firebase (Firestore + Storage + Hosting + Auth + Cloud Functions)

## 설정

```bash
cp firebase-config.example.js firebase-config.js
# firebase-config.js 내 Firebase 프로젝트 설정으로 교체
```

Python API(`eleup_api.py`)를 사용할 경우 `gcloud auth login` 필요(ADC Bearer 토큰).

## 배포

```bash
firebase deploy --only hosting
firebase deploy --only firestore:rules
firebase deploy --only storage
firebase deploy --only functions  # 주간 사용량 리포트
```

## 데이터 구조

| 경로 | 설명 |
|------|------|
| `users/{uid}` | 교사 회원 (role, displayName) |
| `boards/{code}` | 보드 메타 (type, title, status, members, chatPublicEnabled 등) |
| `boards/{code}/submissions/{id}` | 제출물 / 질문 / 분류 카드 |
| `boards/{code}/submissions/{id}/comments/{id}` | 댓글 |
| `boards/{code}/messages/{id}` | 채팅 메시지 |
| `classes/{alias}` | 클래스 (ownerUid, members, chatPublicEnabled) |
| `classes/{alias}/slots/{id}` | 주간 슬롯 (boardCode 또는 externalUrl) |
| `classes/{alias}/messages/{id}` | 클래스 채팅 메시지 |

## Python API

```python
from eleup_api import create_board, create_inquiry_board, add_inquiry_question

code, link = create_board("3월 독서감상문", description="A4 1장")
code, link = create_inquiry_board("3단원 탐구 질문판")
add_inquiry_question(code, "학생이름", "질문 내용", category="factual")
```

CLI:
```bash
python eleup_api.py inquiry "제목" --desc "설명"
```

## 파일 구조

| 파일 | 설명 |
|------|------|
| `index.html` | SPA 마크업 (모든 뷰·모달) |
| `style.css` | 스타일시트 |
| `app.js` | Firebase 연동 + 앱 로직 (ES Module) |
| `eleup_api.py` | Python API 유틸리티 (Firestore REST + gcloud ADC) |
| `usage_report.py` | 주간 사용량 리포트 |
| `functions/index.js` | Cloud Functions (weekly usage report) |
| `firestore.rules` | Firestore 보안 규칙 |
| `storage.rules` | Storage 보안 규칙 |

## 라이선스

MIT
