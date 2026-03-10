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

## 현재 상태
- [x] 기본 UI 구현 (홈/생성/제출/확인 화면)
- [x] Firebase 연동 (Firestore + Storage)
- [x] 파일 업로드 (드래그앤드롭, 50MB 제한)
- [x] 실시간 제출물 표시 (onSnapshot)
- [x] URL 해시 라우팅 (#join/CODE, #board/CODE)
- [ ] Firebase Hosting 배포
- [ ] Firebase 콘솔에서 Firestore/Storage 규칙 적용 필요
