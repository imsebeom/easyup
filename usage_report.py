"""
EasyUp 주간 교사별 사용량/비용 보고서

매주 실행하여 교사별 Firestore/Storage 사용량을 집계하고
추정 비용을 이메일로 발송한다.

사용법:
    python usage_report.py              # 보고서 생성 + 이메일 발송
    python usage_report.py --dry-run    # 콘솔 출력만 (이메일 미발송)
"""

import os
import sys
import smtplib
import json
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

# .env 파일 로드
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

sys.path.insert(0, str(Path(__file__).parent))
from easyup_api import list_all_boards, list_submissions

# ── 설정 ──
REPORT_EMAIL = os.environ.get("REPORT_EMAIL", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
GMAIL_SENDER = os.environ.get("GMAIL_SENDER", REPORT_EMAIL)

LOG_FILE = Path(__file__).parent / "usage_report.log"

# Firebase Blaze 단가 (USD)
PRICING = {
    "firestore_read": 0.06 / 100_000,       # $0.06 / 10만 읽기
    "firestore_write": 0.18 / 100_000,       # $0.18 / 10만 쓰기
    "firestore_delete": 0.02 / 100_000,      # $0.02 / 10만 삭제
    "storage_gb_month": 0.026,               # $0.026 / GB·월
    "storage_download_gb": 0.12,             # $0.12 / GB 다운로드
}

# 무료 할당량 (일일)
FREE_TIER = {
    "firestore_read": 50_000,
    "firestore_write": 20_000,
    "firestore_delete": 20_000,
    "storage_gb": 5,  # 5GB 무료
}


def log(msg):
    entry = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} - {msg}"
    print(entry)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(entry + "\n")


def format_size(b):
    if b < 1024:
        return f"{b}B"
    if b < 1024 * 1024:
        return f"{b / 1024:.1f}KB"
    if b < 1024 * 1024 * 1024:
        return f"{b / (1024 * 1024):.1f}MB"
    return f"{b / (1024 * 1024 * 1024):.2f}GB"


def parse_timestamp(val):
    """Firestore 타임스탬프 문자열을 datetime으로 변환."""
    if isinstance(val, datetime):
        return val
    if isinstance(val, str):
        # ISO 8601 형식
        val = val.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(val)
        except ValueError:
            return None
    return None


def collect_usage():
    """교사별 사용량 데이터 수집."""
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)

    log("전체 보드 조회...")
    boards = list_all_boards()
    log(f"전체 보드 {len(boards)}개")

    # 보드에서 교사 정보 추출 (ownerUid + ownerName)
    teacher_usage = {}
    for board in boards:
        owner = board.get("ownerUid", "unknown")
        if owner not in teacher_usage:
            teacher_usage[owner] = {
                "name": board.get("ownerName", owner),
                "email": "",
                "total_boards": 0,
                "new_boards": 0,
                "total_submissions": 0,
                "new_submissions": 0,
                "total_storage_bytes": 0,
                "new_storage_bytes": 0,
                "firestore_reads": 0,
                "firestore_writes": 0,
            }

    log(f"교사 {len(teacher_usage)}명 확인")

    for board in boards:
        owner = board.get("ownerUid", "unknown")

        usage = teacher_usage[owner]
        usage["total_boards"] += 1

        board_created = parse_timestamp(board.get("createdAt"))
        if board_created and board_created >= week_ago:
            usage["new_boards"] += 1
            usage["firestore_writes"] += 1  # 보드 생성 = 1 쓰기

        code = board.get("code", "")
        if not code:
            continue

        # 제출물 조회
        try:
            submissions = list_submissions(code)
        except Exception as e:
            log(f"  보드 {code} 제출물 조회 실패: {e}")
            submissions = []

        usage["firestore_reads"] += len(submissions) + 1  # 문서 읽기 수

        for sub_id, sub in submissions:
            usage["total_submissions"] += 1

            sub_created = parse_timestamp(sub.get("createdAt"))
            if sub_created and sub_created >= week_ago:
                usage["new_submissions"] += 1
                usage["firestore_writes"] += 1  # 제출 = 1 쓰기

            # 파일 용량 집계
            files = sub.get("files", [])
            if isinstance(files, list):
                for f in files:
                    size = f.get("size", 0) if isinstance(f, dict) else 0
                    usage["total_storage_bytes"] += size
                    if sub_created and sub_created >= week_ago:
                        usage["new_storage_bytes"] += size

    return teacher_usage, now, week_ago


def estimate_cost(usage):
    """교사별 추정 비용 계산."""
    # Storage 비용 (월 기준, 무료 5GB 제외는 전체 합산에서 처리)
    storage_gb = usage["total_storage_bytes"] / (1024 ** 3)
    storage_cost = storage_gb * PRICING["storage_gb_month"]

    # Firestore 비용 (주간 추정 → 월 환산)
    weekly_reads = usage["firestore_reads"]
    weekly_writes = usage["firestore_writes"]
    monthly_reads = weekly_reads * 4
    monthly_writes = weekly_writes * 4

    read_cost = monthly_reads * PRICING["firestore_read"]
    write_cost = monthly_writes * PRICING["firestore_write"]

    total = storage_cost + read_cost + write_cost
    return {
        "storage_cost": storage_cost,
        "read_cost": read_cost,
        "write_cost": write_cost,
        "total": total,
        "storage_gb": storage_gb,
    }


def generate_report(teacher_usage, now, week_ago):
    """HTML 보고서 생성."""
    period = f"{week_ago.strftime('%Y-%m-%d')} ~ {now.strftime('%Y-%m-%d')}"

    # 전체 요약
    total_teachers = len(teacher_usage)
    total_boards = sum(u["total_boards"] for u in teacher_usage.values())
    total_subs = sum(u["total_submissions"] for u in teacher_usage.values())
    total_new_subs = sum(u["new_submissions"] for u in teacher_usage.values())
    total_storage = sum(u["total_storage_bytes"] for u in teacher_usage.values())
    total_cost = 0

    rows = []
    for uid, usage in sorted(teacher_usage.items(), key=lambda x: x[1]["total_submissions"], reverse=True):
        cost = estimate_cost(usage)
        total_cost += cost["total"]
        rows.append({
            "name": usage["name"],
            "email": usage["email"],
            "total_boards": usage["total_boards"],
            "new_boards": usage["new_boards"],
            "total_submissions": usage["total_submissions"],
            "new_submissions": usage["new_submissions"],
            "storage": format_size(usage["total_storage_bytes"]),
            "new_storage": format_size(usage["new_storage_bytes"]),
            "cost": cost["total"],
        })

    # HTML 생성
    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: 'Pretendard', -apple-system, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #333;">
<h2 style="color: #4A90D9; border-bottom: 2px solid #4A90D9; padding-bottom: 8px;">
  EasyUp 주간 사용량 보고서
</h2>
<p style="color: #666; font-size: 14px;">{period}</p>

<table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
  <tr style="background: #f0f4ff;">
    <td style="padding: 8px 12px; font-weight: 600;">총 교사</td>
    <td style="padding: 8px 12px;">{total_teachers}명</td>
    <td style="padding: 8px 12px; font-weight: 600;">총 보드</td>
    <td style="padding: 8px 12px;">{total_boards}개</td>
  </tr>
  <tr>
    <td style="padding: 8px 12px; font-weight: 600;">총 제출물</td>
    <td style="padding: 8px 12px;">{total_subs}건 (+{total_new_subs})</td>
    <td style="padding: 8px 12px; font-weight: 600;">총 저장 용량</td>
    <td style="padding: 8px 12px;">{format_size(total_storage)}</td>
  </tr>
  <tr style="background: #f0f4ff;">
    <td style="padding: 8px 12px; font-weight: 600;">추정 월 비용</td>
    <td colspan="3" style="padding: 8px 12px; font-weight: 700; color: #4A90D9;">${total_cost:.4f}</td>
  </tr>
</table>

<h3 style="color: #333; margin-top: 24px;">교사별 상세</h3>
<table style="width: 100%; border-collapse: collapse; font-size: 13px;">
  <tr style="background: #4A90D9; color: white;">
    <th style="padding: 8px; text-align: left;">교사</th>
    <th style="padding: 8px; text-align: center;">보드</th>
    <th style="padding: 8px; text-align: center;">제출물 (주간)</th>
    <th style="padding: 8px; text-align: center;">저장용량</th>
    <th style="padding: 8px; text-align: right;">추정 비용</th>
  </tr>"""

    for i, row in enumerate(rows):
        bg = ' style="background: #f8f9fa;"' if i % 2 == 1 else ""
        html += f"""
  <tr{bg}>
    <td style="padding: 8px;">{row['name']}</td>
    <td style="padding: 8px; text-align: center;">{row['total_boards']} (+{row['new_boards']})</td>
    <td style="padding: 8px; text-align: center;">{row['total_submissions']} (+{row['new_submissions']})</td>
    <td style="padding: 8px; text-align: center;">{row['storage']}</td>
    <td style="padding: 8px; text-align: right;">${row['cost']:.4f}</td>
  </tr>"""

    html += """
</table>

<p style="color: #999; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
  * 비용은 Firebase Blaze 단가 기준 추정치입니다. 실제 청구 금액은 Firebase Console에서 확인하세요.<br>
  * 무료 할당량(Firestore 읽기 5만/일, 쓰기 2만/일, Storage 5GB)은 별도 차감하지 않은 총 추정치입니다.
</p>
</body>
</html>"""

    return html, period


def send_email(html, period):
    """Gmail SMTP로 보고서 발송."""
    if not REPORT_EMAIL or not GMAIL_APP_PASSWORD:
        log("REPORT_EMAIL 또는 GMAIL_APP_PASSWORD 미설정 — 이메일 발송 건너뜀")
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"[EasyUp] 주간 사용량 보고서 ({period})"
    msg["From"] = GMAIL_SENDER
    msg["To"] = REPORT_EMAIL

    msg.attach(MIMEText(html, "html", "utf-8"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(GMAIL_SENDER, GMAIL_APP_PASSWORD)
            server.send_message(msg)
        log(f"이메일 발송 완료 → {REPORT_EMAIL}")
        return True
    except Exception as e:
        log(f"이메일 발송 실패: {e}")
        return False


def main():
    dry_run = "--dry-run" in sys.argv

    log("===== EasyUp 주간 사용량 보고서 시작 =====")

    try:
        teacher_usage, now, week_ago = collect_usage()
        html, period = generate_report(teacher_usage, now, week_ago)

        # HTML 파일로 저장 (확인용)
        report_path = Path(__file__).parent / "latest_report.html"
        report_path.write_text(html, encoding="utf-8")
        log(f"보고서 저장: {report_path}")

        if dry_run:
            log("--dry-run: 이메일 발송 건너뜀")
        else:
            send_email(html, period)

    except Exception as e:
        log(f"오류 발생: {e}")
        raise

    log("===== 보고서 완료 =====")


if __name__ == "__main__":
    main()
