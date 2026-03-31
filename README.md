# EasyUp - 과제 수합 / 탐구 질문판

Padlet 대안으로, 교사가 보드를 만들고 학생들이 과제를 제출하는 웹앱입니다.

## 주요 기능

- **과제 수합 보드**: 학생이 URL/텍스트/파일로 과제 제출
- **탐구 질문판**: 카테고리별 Shelf 레이아웃, 좋아요, 드래그 이동
- **교사 대시보드**: 보드 생성/관리, 회원 승인, QR 코드 공유
- **학생 접근**: 로그인 없이 보드 코드로 접속, deviceId 기반 식별

## 기술 스택

- **프론트엔드**: Vanilla HTML/CSS/JS (빌드 도구 없음)
- **백엔드**: Firebase (Firestore + Storage + Hosting + Auth)

## 배포

```bash
firebase deploy --project easyup-1604e --only hosting
```

**URL**: https://easyup-1604e.web.app/

## API 유틸리티

`easyup_api.py`로 보드를 프로그래밍적으로 관리할 수 있습니다.

```python
from easyup_api import create_board, create_inquiry_board, add_inquiry_question

# 과제 수합 보드 생성
code, link = create_board("3월 독서감상문", description="A4 1장")

# 탐구 질문판 생성
code, link = create_inquiry_board("3단원 탐구 질문판")

# 질문 시드 추가
add_inquiry_question(code, "학생이름", "질문 내용", category="factual")
```

CLI:
```bash
python easyup_api.py inquiry "제목" --desc "설명"
```

## 파일 구조

| 파일 | 설명 |
|------|------|
| `index.html` | 메인 HTML (SPA) |
| `style.css` | 스타일시트 |
| `app.js` | Firebase 연동 및 앱 로직 |
| `easyup_api.py` | Python API 유틸리티 |
| `firestore.rules` | Firestore 보안 규칙 |
| `storage.rules` | Storage 보안 규칙 |

## 라이선스

MIT
