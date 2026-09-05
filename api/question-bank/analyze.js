// /api/question-bank/analyze.js
// Nhận ảnh/PDF câu hỏi từ frontend, gửi cho Gemini Vision (API key miễn phí),
// trả về JSON { questions: [...] } đúng schema mà index.html đang mong đợi.

const Busboy = require('busboy');

const GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Dùng POST.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Thiếu biến môi trường GEMINI_API_KEY trên Vercel. Vào Project Settings > Environment Variables để thêm.'
    });
    return;
  }

  try {
    const { files, sourceMetadata } = await parseMultipart(req);

    if (!files.length) {
      res.status(400).json({ error: 'Không có file nào được gửi lên.' });
      return;
    }

    // Giới hạn an toàn: tối đa 8 file / lần gọi, mỗi file <= 15MB
    if (files.length > 8) {
      res.status(400).json({ error: 'Chỉ hỗ trợ tối đa 8 file mỗi lần nhận diện.' });
      return;
    }
    for (const f of files) {
      if (f.buffer.length > 15 * 1024 * 1024) {
        res.status(400).json({ error: `File "${f.filename}" vượt quá 15MB.` });
        return;
      }
    }

    const promptText = buildPrompt(sourceMetadata, files);

    const parts = [
      { text: promptText },
      ...files.map((f) => ({
        inline_data: {
          mime_type: f.mimeType,
          data: f.buffer.toString('base64')
        }
      }))
    ];

    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.2,
          response_mime_type: 'application/json'
        }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      res.status(502).json({
        error: `Gemini API trả lỗi (${geminiRes.status}): ${errText.slice(0, 400)}`
      });
      return;
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      res.status(502).json({ error: 'Gemini không trả về nội dung. Có thể do bộ lọc an toàn hoặc file không đọc được.' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      res.status(502).json({ error: 'AI trả về dữ liệu không đúng định dạng JSON.' });
      return;
    }

    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    const withSourceNames = questions.map((q) => ({
      ...q,
      sourceFile: files[q.sourceIndex]?.filename || files[0]?.filename || ''
    }));

    res.status(200).json({ questions: withSourceNames });
  } catch (err) {
    console.error('question-bank/analyze error:', err);
    res.status(500).json({ error: err.message || 'Lỗi không xác định trên server.' });
  }
};

function buildPrompt(sourceMetadataRaw, files) {
  let meta = [];
  try {
    meta = JSON.parse(sourceMetadataRaw || '[]');
  } catch (e) {
    // bỏ qua, dùng danh sách file thay thế
  }
  const fileList = files
    .map((f, i) => `  [${i}] ${f.filename}`)
    .join('\n');

  return `Bạn là trợ lý OCR và phân loại câu hỏi Toán lớp 12 cho một ngân hàng câu hỏi trắc nghiệm.

Danh sách file đính kèm (theo đúng thứ tự, đánh số từ 0):
${fileList}

Nhiệm vụ với TỪNG file (một file có thể chứa NHIỀU câu hỏi, một PDF có thể có nhiều trang):
1. OCR toàn bộ nội dung câu hỏi, giữ nguyên chính xác số liệu, ký hiệu, đáp án — không tự ý sửa nghĩa toán học.
2. Chuẩn hóa lại câu chữ tiếng Việt cho rõ ràng, đúng chính tả (chỉ sửa lỗi OCR/diễn đạt, KHÔNG thay đổi nội dung toán học).
3. Nếu có công thức toán, viết lại chính xác dưới dạng LaTeX vào "questionLatex".
4. Phân loại mỗi câu theo: chapter (mã 2 chữ số từ 01-06), topic (chủ đề), problemType (dạng bài), skill (kỹ năng cần dùng), level (A=Nhận biết, B=Thông hiểu, C=Vận dụng, D=Vận dụng cao), format (một trong: "Trắc nghiệm 4 lựa chọn", "Đúng/Sai", "Trả lời ngắn", "Tự luận").
5. Ghi "sourceIndex" = số thứ tự file nguồn (đúng theo danh sách trên, bắt đầu từ 0). Nếu file là PDF, ghi thêm "sourcePage" (số trang, dạng chuỗi).
6. Tự đánh giá độ tin cậy: "ocrConfidence" và "classificationConfidence", giá trị từ 0 đến 1.
7. Nếu là trắc nghiệm 4 lựa chọn, điền đủ mảng "options" gồm 4 phần tử (không gồm tiền tố A/B/C/D). Nếu không phải trắc nghiệm 4 lựa chọn, để mảng rỗng.

CHỈ trả về đúng một JSON object theo cấu trúc sau, không thêm chữ giải thích, không thêm markdown:
{
  "questions": [
    {
      "sourceIndex": 0,
      "sourcePage": "",
      "code": "",
      "chapter": "01",
      "topic": "",
      "problemType": "",
      "skill": "",
      "level": "B",
      "format": "Trắc nghiệm 4 lựa chọn",
      "questionText": "",
      "questionLatex": "",
      "options": ["", "", "", ""],
      "correctAnswer": "",
      "solution": "",
      "ocrConfidence": 0.9,
      "classificationConfidence": 0.8
    }
  ]
}`;
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers });
    } catch (e) {
      reject(new Error('Request không đúng định dạng multipart/form-data.'));
      return;
    }

    const files = [];
    let sourceMetadata = '[]';

    busboy.on('file', (fieldname, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      file.on('data', (d) => chunks.push(d));
      file.on('end', () => {
        files.push({ filename, mimeType, buffer: Buffer.concat(chunks) });
      });
    });

    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'sourceMetadata') sourceMetadata = val;
    });

    busboy.on('finish', () => resolve({ files, sourceMetadata }));
    busboy.on('error', (e) => reject(e));

    req.pipe(busboy);
  });
}
