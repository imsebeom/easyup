# EasyUp - 과제 수합 도구

## 프로젝트 개요
Padlet 대안으로, 교사가 과제 보드를 만들고 학생들이 URL/텍스트/파일로 과제를 제출하는 웹앱.

## 기술 스택
- **프론트엔드**: Vanilla HTML/CSS/JS (빌드 도구 없음)
- **백엔드**: Firebase (Firestore + Storage + Hosting)
- **프로젝트 ID**: easyup-1604e

## 파일 구조
- `index.html` - 메인 HTML (SPA, 모든 뷰 포함)
- `style.css` - 스타일시트
- `app.js` - Firebase 연동 및 앱 로직 (ES Module)
- `firestore.rules` - Firestore 보안 규칙
- `storage.rules` - Storage 보안 규칙
- `firebase.json` - Firebase 호스팅 설정

## 데이터 구조
- `boards/{code}` - 과제 보드 (title, description, deadline, allowUrl/Text/File)
- `boards/{code}/submissions/{id}` - 제출물 (name, type, content, files[], memo)
- Storage: `boards/{code}/{timestamp}_{filename}`

## 배포
- **URL**: https://easyup-1604e.web.app/
- **명령어**: `firebase deploy --project easyup-1604e --only hosting`

## 주요 설계 결정
- **학생 식별**: 로그인 없이 `deviceId` (localStorage UUID)로 본인 제출물 수정/삭제
- **XSS 방지**: inline onclick 대신 이벤트 위임 + `data-*` 속성 사용
- **URL 안전**: `sanitizeUrl()`로 `javascript:` 프로토콜 차단
- **보드 코드**: 6자리 (30문자 알파벳, ~729M 조합), 충돌 검사 불필요

## 주의사항
- Firestore `where()` + `orderBy()` 복합 쿼리 → 반드시 복합 색인(`firestore.indexes.json`) 필요
- `<input type="file">` 파일 제거 후 `.value = ''` 리셋 필수 (같은 파일 재선택 불가)
- 이벤트 핸들러를 프로그래밍적으로 호출 시 `event` 객체 없음 주의

## 현재 상태
- [x] 기본 UI 구현 (교사 대시보드, 학생 갤러리 뷰, 제출 모달)
- [x] Firebase 연동 (Firestore + Storage + Auth)
- [x] 파일 업로드 (드래그앤드롭, 1GB 제한)
- [x] 실시간 제출물 표시 (onSnapshot)
- [x] URL 해시 라우팅 (#join/CODE, #board/CODE)
- [x] Firebase Hosting 배포 완료
- [x] XSS 방지 (이벤트 위임, URL sanitize)
- [x] deviceId 기반 본인 제출물 수정/삭제
- [ ] Firestore rules 강화 (submissions update/delete가 현재 if true)
- [ ] 모바일 반응형 테스트
