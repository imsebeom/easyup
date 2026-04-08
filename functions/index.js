const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

// Firebase Functions secrets
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const REPORT_EMAIL = defineSecret("REPORT_EMAIL");
const GMAIL_SENDER = defineSecret("GMAIL_SENDER");

// Firebase Blaze 단가 (USD)
const PRICING = {
  firestoreRead: 0.06 / 100_000,
  firestoreWrite: 0.18 / 100_000,
  storageGbMonth: 0.026,
  storageDownloadGb: 0.12,
};

function formatSize(b) {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)}MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

async function collectUsage() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // 전체 보드 조회
  const boardsSnap = await db.collection("boards").orderBy("createdAt", "desc").get();
  const boards = [];
  boardsSnap.forEach((doc) => boards.push({ id: doc.id, ...doc.data() }));

  // 교사별 집계 (보드의 ownerUid/ownerName에서 추출)
  const teacherUsage = {};

  for (const board of boards) {
    const owner = board.ownerUid || "unknown";
    if (!teacherUsage[owner]) {
      teacherUsage[owner] = {
        name: board.ownerName || owner,
        totalBoards: 0,
        newBoards: 0,
        totalSubmissions: 0,
        newSubmissions: 0,
        totalStorageBytes: 0,
        newStorageBytes: 0,
        firestoreReads: 0,
        firestoreWrites: 0,
      };
    }

    const usage = teacherUsage[owner];
    usage.totalBoards++;

    const boardCreated = board.createdAt?.toDate?.() || null;
    if (boardCreated && boardCreated >= weekAgo) {
      usage.newBoards++;
      usage.firestoreWrites++;
    }

    const code = board.code || board.id;

    // 제출물 조회
    const subsSnap = await db
      .collection("boards")
      .doc(code)
      .collection("submissions")
      .get();

    usage.firestoreReads += subsSnap.size + 1;

    subsSnap.forEach((subDoc) => {
      const sub = subDoc.data();
      usage.totalSubmissions++;

      const subCreated = sub.createdAt?.toDate?.() || null;
      if (subCreated && subCreated >= weekAgo) {
        usage.newSubmissions++;
        usage.firestoreWrites++;
      }

      // 파일 용량
      const files = sub.files || [];
      for (const f of files) {
        const size = f.size || 0;
        usage.totalStorageBytes += size;
        if (subCreated && subCreated >= weekAgo) {
          usage.newStorageBytes += size;
        }
      }
    });
  }

  return { teacherUsage, now, weekAgo, totalBoards: boards.length };
}

function estimateCost(usage) {
  const storageGb = usage.totalStorageBytes / (1024 ** 3);
  const storageCost = storageGb * PRICING.storageGbMonth;
  const monthlyReads = usage.firestoreReads * 4;
  const monthlyWrites = usage.firestoreWrites * 4;
  const readCost = monthlyReads * PRICING.firestoreRead;
  const writeCost = monthlyWrites * PRICING.firestoreWrite;
  return { storageCost, readCost, writeCost, total: storageCost + readCost + writeCost };
}

function generateReport(teacherUsage, now, weekAgo) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const period = `${fmt(weekAgo)} ~ ${fmt(now)}`;

  const totalTeachers = Object.keys(teacherUsage).length;
  let totalBoards = 0, totalSubs = 0, totalNewSubs = 0, totalStorage = 0, totalCost = 0;

  const rows = [];
  for (const [uid, usage] of Object.entries(teacherUsage)) {
    totalBoards += usage.totalBoards;
    totalSubs += usage.totalSubmissions;
    totalNewSubs += usage.newSubmissions;
    totalStorage += usage.totalStorageBytes;

    const cost = estimateCost(usage);
    totalCost += cost.total;

    rows.push({
      name: usage.name,
      totalBoards: usage.totalBoards,
      newBoards: usage.newBoards,
      totalSubmissions: usage.totalSubmissions,
      newSubmissions: usage.newSubmissions,
      storage: formatSize(usage.totalStorageBytes),
      cost: cost.total,
    });
  }

  rows.sort((a, b) => b.totalSubmissions - a.totalSubmissions);

  let teacherRows = "";
  rows.forEach((row, i) => {
    const bg = i % 2 === 1 ? ' style="background: #f8f9fa;"' : "";
    teacherRows += `
  <tr${bg}>
    <td style="padding: 8px;">${row.name}</td>
    <td style="padding: 8px; text-align: center;">${row.totalBoards} (+${row.newBoards})</td>
    <td style="padding: 8px; text-align: center;">${row.totalSubmissions} (+${row.newSubmissions})</td>
    <td style="padding: 8px; text-align: center;">${row.storage}</td>
    <td style="padding: 8px; text-align: right;">$${row.cost.toFixed(4)}</td>
  </tr>`;
  });

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: 'Pretendard', -apple-system, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #333;">
<h2 style="color: #4A90D9; border-bottom: 2px solid #4A90D9; padding-bottom: 8px;">
  EleUp 주간 사용량 보고서
</h2>
<p style="color: #666; font-size: 14px;">${period}</p>

<table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
  <tr style="background: #f0f4ff;">
    <td style="padding: 8px 12px; font-weight: 600;">총 교사</td>
    <td style="padding: 8px 12px;">${totalTeachers}명</td>
    <td style="padding: 8px 12px; font-weight: 600;">총 보드</td>
    <td style="padding: 8px 12px;">${totalBoards}개</td>
  </tr>
  <tr>
    <td style="padding: 8px 12px; font-weight: 600;">총 제출물</td>
    <td style="padding: 8px 12px;">${totalSubs}건 (+${totalNewSubs})</td>
    <td style="padding: 8px 12px; font-weight: 600;">총 저장 용량</td>
    <td style="padding: 8px 12px;">${formatSize(totalStorage)}</td>
  </tr>
  <tr style="background: #f0f4ff;">
    <td style="padding: 8px 12px; font-weight: 600;">추정 월 비용</td>
    <td colspan="3" style="padding: 8px 12px; font-weight: 700; color: #4A90D9;">$${totalCost.toFixed(4)}</td>
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
  </tr>
  ${teacherRows}
</table>

<p style="color: #999; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
  * 비용은 Firebase Blaze 단가 기준 추정치입니다. 실제 청구 금액은 Firebase Console에서 확인하세요.<br>
  * 무료 할당량(Firestore 읽기 5만/일, 쓰기 2만/일, Storage 5GB)은 별도 차감하지 않은 총 추정치입니다.
</p>
</body>
</html>`;

  return { html, period };
}

async function sendEmail(html, period, secrets) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: secrets.sender,
      pass: secrets.password,
    },
  });

  await transporter.sendMail({
    from: secrets.sender,
    to: secrets.recipient,
    subject: `[EleUp] 주간 사용량 보고서 (${period})`,
    html,
  });
}

// ── 매주 월요일 09:00 KST (= 00:00 UTC) 실행 ──
exports.weeklyUsageReport = onSchedule(
  {
    schedule: "0 0 * * 1",
    timeZone: "Asia/Seoul",
    secrets: [GMAIL_APP_PASSWORD, REPORT_EMAIL, GMAIL_SENDER],
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    console.log("주간 사용량 보고서 생성 시작");
    const { teacherUsage, now, weekAgo } = await collectUsage();
    const { html, period } = generateReport(teacherUsage, now, weekAgo);

    await sendEmail(html, period, {
      sender: GMAIL_SENDER.value(),
      password: GMAIL_APP_PASSWORD.value(),
      recipient: REPORT_EMAIL.value(),
    });

    console.log(`보고서 발송 완료: ${period}`);
  }
);

// ── 수동 테스트용 HTTP 엔드포인트 ──
exports.testUsageReport = onRequest(
  {
    secrets: [GMAIL_APP_PASSWORD, REPORT_EMAIL, GMAIL_SENDER],
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (req, res) => {
    try {
      console.log("테스트 보고서 생성 시작");
      const { teacherUsage, now, weekAgo } = await collectUsage();
      const { html, period } = generateReport(teacherUsage, now, weekAgo);

      await sendEmail(html, period, {
        sender: GMAIL_SENDER.value(),
        password: GMAIL_APP_PASSWORD.value(),
        recipient: REPORT_EMAIL.value(),
      });

      res.send(`보고서 발송 완료: ${period}`);
    } catch (err) {
      console.error("오류:", err);
      res.status(500).send(`오류: ${err.message}`);
    }
  }
);
