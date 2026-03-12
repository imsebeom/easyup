"""
EasyUp API — 보드 생성/조회 유틸리티

사용법:
    from easyup_api import create_board, create_inquiry_board, get_board, get_join_link

    # 과제 수합 보드
    code = create_board("3월 독서감상문", description="A4 1장 분량")

    # 탐구 질문판
    code = create_inquiry_board("3단원 탐구 질문판", description="지층과 화석에 대해 궁금한 점")

    # 참여 링크
    print(get_join_link(code))  # https://easyup-1604e.web.app/#join/ABC123

CLI:
    python easyup_api.py assignment "과제 제목" --desc "설명"
    python easyup_api.py inquiry "질문판 제목" --desc "설명"
"""

import sys, json, string, random, requests
from datetime import datetime, timezone

# ── Constants ──
PROJECT_ID = "easyup-1604e"
API_KEY = "REDACTED_API_KEY"
BASE_URL = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents"
HOSTING_URL = "https://easyup-1604e.web.app"

# Owner UID for API-created boards (admin account)
OWNER_UID = "api"
OWNER_NAME = "EasyUp API"

CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

INQUIRY_CATEGORIES = ["factual", "conceptual", "debatable", "featured", "resolved"]


def _generate_code(length=6):
    return "".join(random.choices(CODE_CHARS, k=length))


def _to_firestore_value(v):
    """Python 값 → Firestore REST API 값 형식"""
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, datetime):
        return {"timestampValue": v.isoformat()}
    if isinstance(v, list):
        return {"arrayValue": {"values": [_to_firestore_value(i) for i in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: _to_firestore_value(val) for k, val in v.items()}}}
    return {"stringValue": str(v)}


def _from_firestore_value(v):
    """Firestore REST API 값 → Python 값"""
    if "stringValue" in v:
        return v["stringValue"]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "booleanValue" in v:
        return v["booleanValue"]
    if "nullValue" in v:
        return None
    if "timestampValue" in v:
        return v["timestampValue"]
    if "arrayValue" in v:
        return [_from_firestore_value(i) for i in v["arrayValue"].get("values", [])]
    if "mapValue" in v:
        return {k: _from_firestore_value(val) for k, val in v["mapValue"].get("fields", {}).items()}
    if "doubleValue" in v:
        return v["doubleValue"]
    return str(v)


def _create_document(collection_path, doc_id, fields):
    """Firestore REST API로 문서 생성"""
    url = f"{BASE_URL}/{collection_path}?documentId={doc_id}&key={API_KEY}"
    body = {"fields": {k: _to_firestore_value(v) for k, v in fields.items()}}
    resp = requests.post(url, json=body)
    if resp.status_code not in (200, 201):
        raise Exception(f"Firestore 문서 생성 실패 ({resp.status_code}): {resp.text}")
    return resp.json()


def _get_document(doc_path):
    """Firestore REST API로 문서 조회"""
    url = f"{BASE_URL}/{doc_path}?key={API_KEY}"
    resp = requests.get(url)
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise Exception(f"Firestore 문서 조회 실패 ({resp.status_code}): {resp.text}")
    raw = resp.json()
    fields = raw.get("fields", {})
    return {k: _from_firestore_value(v) for k, v in fields.items()}


def get_join_link(code):
    """학생 참여 링크 반환"""
    return f"{HOSTING_URL}/#join/{code}"


def get_teacher_link(code):
    """교사 보드 링크 반환"""
    return f"{HOSTING_URL}/#board/{code}"


def get_board(code):
    """보드 정보 조회. 없으면 None 반환."""
    return _get_document(f"boards/{code}")


def create_board(title, description="", deadline=None,
                 allow_url=True, allow_text=True, allow_file=True,
                 owner_uid=OWNER_UID, owner_name=OWNER_NAME):
    """
    과제 수합 보드 생성.

    Returns: (code, join_link)
    """
    code = _generate_code()
    fields = {
        "title": title,
        "description": description,
        "deadline": deadline,
        "type": "assignment",
        "allowUrl": allow_url,
        "allowText": allow_text,
        "allowFile": allow_file,
        "code": code,
        "ownerUid": owner_uid,
        "ownerName": owner_name,
        "createdAt": datetime.now(timezone.utc),
    }
    _create_document("boards", code, fields)
    return code, get_join_link(code)


def create_inquiry_board(title, description="", deadline=None,
                         categories=None,
                         owner_uid=OWNER_UID, owner_name=OWNER_NAME):
    """
    탐구 질문판 보드 생성.

    Returns: (code, join_link)
    """
    code = _generate_code()
    fields = {
        "title": title,
        "description": description,
        "deadline": deadline,
        "type": "inquiry",
        "categories": categories or INQUIRY_CATEGORIES,
        "code": code,
        "ownerUid": owner_uid,
        "ownerName": owner_name,
        "createdAt": datetime.now(timezone.utc),
    }
    _create_document("boards", code, fields)
    return code, get_join_link(code)


def add_inquiry_question(board_code, name, content, category="factual", device_id="api"):
    """
    질문판에 질문 추가 (테스트/시드 데이터용).

    Returns: submission_id
    """
    import time
    sub_id = f"{int(time.time()*1000)}_{random.randint(100000, 999999)}"
    fields = {
        "name": name,
        "content": content,
        "category": category,
        "likes": 0,
        "likedBy": [],
        "deviceId": device_id,
        "boardCode": board_code,
        "createdAt": datetime.now(timezone.utc),
    }
    _create_document(f"boards/{board_code}/submissions", sub_id, fields)
    return sub_id


# ── CLI ──
if __name__ == "__main__":
    sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

    if len(sys.argv) < 3:
        print("사용법: python easyup_api.py <assignment|inquiry> <제목> [--desc 설명]")
        sys.exit(1)

    board_type = sys.argv[1]
    title = sys.argv[2]
    desc = ""
    if "--desc" in sys.argv:
        desc_idx = sys.argv.index("--desc") + 1
        if desc_idx < len(sys.argv):
            desc = sys.argv[desc_idx]

    if board_type == "assignment":
        code, link = create_board(title, description=desc)
    elif board_type == "inquiry":
        code, link = create_inquiry_board(title, description=desc)
    else:
        print(f"알 수 없는 보드 유형: {board_type}")
        sys.exit(1)

    print(f"보드 생성 완료!")
    print(f"  코드: {code}")
    print(f"  참여 링크: {link}")
    print(f"  교사 링크: {get_teacher_link(code)}")
