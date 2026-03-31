"""
EasyUp API — 보드 생성/조회 유틸리티

사용법:
    from easyup_api import create_board, create_inquiry_board, get_board, get_join_link

    # 과제 수합 보드
    code = create_board("3월 독서감상문", description="A4 1장 분량")

    # 탐구 질문판
    code = create_inquiry_board("3단원 탐구 질문판", description="지층과 화석에 대해 궁금한 점")

    # 참여 링크
    print(get_join_link(code))  # https://YOUR_PROJECT.web.app/#join/ABC123

CLI:
    python easyup_api.py assignment "과제 제목" --desc "설명"
    python easyup_api.py inquiry "질문판 제목" --desc "설명"
"""

import os, sys, json, time, random, requests
from datetime import datetime, timezone

# ── Constants ──
PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "")
API_KEY = os.environ.get("FIREBASE_API_KEY", "")
BASE_URL = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents"
HOSTING_URL = os.environ.get("FIREBASE_HOSTING_URL", f"https://{PROJECT_ID}.web.app")

OWNER_UID = os.environ.get("EASYUP_OWNER_UID", "")
OWNER_NAME = os.environ.get("EASYUP_OWNER_NAME", "")

CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

INQUIRY_CATEGORIES = ["factual", "conceptual", "debatable", "featured", "resolved"]


def _generate_code(length=6):
    return "".join(random.choices(CODE_CHARS, k=length))


def _generate_sub_id():
    return f"{int(time.time()*1000)}_{random.randint(100000, 999999)}"


def _update_document(doc_path, **fields):
    url = f"{BASE_URL}/{doc_path}?key={API_KEY}"
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in fields)
    url = f"{url}&{mask}"
    body = {"fields": {k: _to_firestore_value(v) for k, v in fields.items()}}
    resp = requests.patch(url, json=body)
    if resp.status_code != 200:
        raise Exception(f"Firestore 문서 수정 실패 ({resp.status_code}): {resp.text}")
    return True


def _delete_document(doc_path):
    url = f"{BASE_URL}/{doc_path}?key={API_KEY}"
    resp = requests.delete(url)
    if resp.status_code not in (200, 204):
        raise Exception(f"Firestore 문서 삭제 실패 ({resp.status_code}): {resp.text}")
    return True


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


def list_boards(owner_uid=OWNER_UID):
    """소유자의 보드 목록 조회. Returns: list of dict."""
    url = f"{BASE_URL}:runQuery?key={API_KEY}"
    body = {
        "structuredQuery": {
            "from": [{"collectionId": "boards"}],
            "where": {
                "fieldFilter": {
                    "field": {"fieldPath": "ownerUid"},
                    "op": "EQUAL",
                    "value": {"stringValue": owner_uid},
                }
            },
            "orderBy": [{"field": {"fieldPath": "createdAt"}, "direction": "DESCENDING"}],
        }
    }
    resp = requests.post(url, json=body)
    if resp.status_code != 200:
        raise Exception(f"보드 목록 조회 실패 ({resp.status_code}): {resp.text}")
    results = []
    for item in resp.json():
        doc = item.get("document")
        if not doc:
            continue
        fields = doc.get("fields", {})
        board = {k: _from_firestore_value(v) for k, v in fields.items()}
        results.append(board)
    return results


def list_submissions(board_code):
    """보드의 제출물/질문 목록 조회. Returns: list of (id, dict)."""
    results = []
    page_token = None
    while True:
        url = f"{BASE_URL}/boards/{board_code}/submissions?key={API_KEY}&pageSize=500"
        if page_token:
            url += f"&pageToken={page_token}"
        resp = requests.get(url)
        if resp.status_code != 200:
            raise Exception(f"제출물 조회 실패 ({resp.status_code}): {resp.text}")
        data = resp.json()
        for doc in data.get("documents", []):
            doc_id = doc["name"].split("/")[-1]
            fields = doc.get("fields", {})
            submission = {k: _from_firestore_value(v) for k, v in fields.items()}
            results.append((doc_id, submission))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return results


def list_users(role=None):
    """사용자 목록 조회. role 지정 시 해당 역할만 필터. Returns: list of (uid, dict)."""
    results = []
    page_token = None
    while True:
        url = f"{BASE_URL}/users?key={API_KEY}&pageSize=500"
        if page_token:
            url += f"&pageToken={page_token}"
        resp = requests.get(url)
        if resp.status_code != 200:
            raise Exception(f"사용자 조회 실패 ({resp.status_code}): {resp.text}")
        data = resp.json()
        for doc in data.get("documents", []):
            uid = doc["name"].split("/")[-1]
            fields_data = doc.get("fields", {})
            user = {k: _from_firestore_value(v) for k, v in fields_data.items()}
            if role is None or user.get("role") == role:
                results.append((uid, user))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return results


def list_all_boards():
    """전체 보드 목록 조회 (소유자 무관). Returns: list of dict."""
    url = f"{BASE_URL}:runQuery?key={API_KEY}"
    body = {
        "structuredQuery": {
            "from": [{"collectionId": "boards"}],
            "orderBy": [{"field": {"fieldPath": "createdAt"}, "direction": "DESCENDING"}],
        }
    }
    resp = requests.post(url, json=body)
    if resp.status_code != 200:
        raise Exception(f"전체 보드 조회 실패 ({resp.status_code}): {resp.text}")
    results = []
    for item in resp.json():
        doc = item.get("document")
        if not doc:
            continue
        fields_data = doc.get("fields", {})
        board = {k: _from_firestore_value(v) for k, v in fields_data.items()}
        results.append(board)
    return results


def update_board(code, **fields):
    """보드 필드 업데이트. 변경할 필드만 kwargs로 전달."""
    return _update_document(f"boards/{code}", **fields)


def delete_board(code):
    """보드 삭제 (하위 submissions는 별도 삭제 필요)."""
    return _delete_document(f"boards/{code}")


def add_submission(board_code, name, content, sub_type="text", title="",
                   device_id="api", memo="", files=None):
    """
    과제 수합 보드에 제출물 추가 (텍스트/URL).

    Returns: submission_id
    """
    sub_id = _generate_sub_id()
    fields = {
        "name": name,
        "content": content,
        "type": sub_type,
        "title": title,
        "memo": memo,
        "files": files or [],
        "deviceId": device_id,
        "boardCode": board_code,
        "createdAt": datetime.now(timezone.utc),
    }
    _create_document(f"boards/{board_code}/submissions", sub_id, fields)
    return sub_id


def update_submission(board_code, sub_id, **fields):
    """제출물 필드 업데이트."""
    return _update_document(f"boards/{board_code}/submissions/{sub_id}", **fields)


def delete_submission(board_code, sub_id):
    """제출물 삭제."""
    return _delete_document(f"boards/{board_code}/submissions/{sub_id}")


def delete_all_submissions(board_code):
    """보드의 모든 제출물 삭제."""
    subs = list_submissions(board_code)
    for sub_id, _ in subs:
        delete_submission(board_code, sub_id)
    return len(subs)


def add_inquiry_question(board_code, name, content, category="factual", device_id="api"):
    """
    질문판에 질문 추가 (테스트/시드 데이터용).

    Returns: submission_id
    """
    sub_id = _generate_sub_id()
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
