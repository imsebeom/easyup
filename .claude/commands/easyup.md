---
name: easyup
description: "EasyUp 보드 관리 스킬. 보드 생성/조회/삭제, 제출물 추가, 질문 시드 생성. /easyup [명령] [인자]"
---

# EasyUp 관리 스킬

프로젝트 루트의 `easyup_api.py`를 사용하여 보드를 관리한다.

## 사용법

```
/easyup                        # 내 보드 목록 조회
/easyup 과제 "제목"             # 과제 수합 보드 생성
/easyup 질문판 "제목"           # 탐구 질문판 생성
/easyup 보기 CODE              # 보드 상세 + 제출물 조회
/easyup 제출 CODE "이름" "내용" # 제출물/질문 추가
/easyup 삭제 CODE              # 보드 삭제 (제출물 포함)
/easyup 시드 CODE 5            # 예시 질문 N개 자동 생성
```

## 주요 API 함수

```python
from easyup_api import *

# 보드
list_boards()                                    # 목록 조회
create_board(title, description="")              # 과제 보드 생성 → (code, link)
create_inquiry_board(title, description="")      # 질문판 생성 → (code, link)
get_board(code)                                  # 보드 조회
update_board(code, **fields)                     # 수정
delete_board(code)                               # 삭제

# 제출물
list_submissions(board_code)                     # 목록
add_submission(board_code, name, content)         # 과제 제출
add_inquiry_question(board_code, name, content, category="factual")
delete_all_submissions(board_code)               # 전체 삭제

# 링크
get_join_link(code)                              # 학생 참여 링크
get_teacher_link(code)                           # 교사 보드 링크
```

## 워크플로

- **목록 조회**: `list_boards()` → 코드/유형/제목/제출물수 테이블 출력
- **보드 생성**: 생성 후 코드, 참여 링크, 교사 링크 출력
- **시드 데이터**: 보드 주제에 맞는 예시 질문을 factual/conceptual/debatable 균등 생성
- **삭제**: 사용자 확인 → `delete_all_submissions()` → `delete_board()`

## 실행

```bash
PYTHONIOENCODING=utf-8 python -c "from easyup_api import *; list_boards()"
```

## 질문판 카테고리

| key | icon | label | 비고 |
|-----|------|-------|------|
| factual | 🔍 | 사실적 질문 | 학생 선택 가능 |
| conceptual | 💡 | 개념적 질문 | 학생 선택 가능 |
| debatable | ⚖️ | 논쟁적 질문 | 학생 선택 가능 |
| featured | ⭐ | 이번 주 탐구 질문 | 교사 전용 |
| resolved | ✅ | 해결된 질문 | 교사 전용 |
