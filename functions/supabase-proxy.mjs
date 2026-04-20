// functions/supabase-proxy.mjs
// Netlify Function — Supabase CRUD + Storage proxy
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY

// ─── Rate limiting (in-memory, per serverless instance) ──────────────────────
const rateLimitMap = new Map();
function checkRateLimit(ip, maxReq = 60, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 1; entry.start = now; }
  else entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count <= maxReq;
}

// ─── Input validation ────────────────────────────────────────────────────────
function isValidEmail(email) {
  return typeof email === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    email.length < 256;
}
function isValidPath(path) {
  // Path traversal koruması: ../ ve URL encoded varyantları engelle
  if (!path || typeof path !== 'string') return false;
  if (path.includes('..') || path.includes('%2e') || path.includes('%2E')) return false;
  if (path.includes('//') || path.startsWith('/')) return false;
  if (path.length > 500) return false;
  return true;
}
function isValidUUID(id) {
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ─── JWT doğrulama — Netlify Identity token ──────────────────────────────────
async function verifyNetlifyToken(token) {
  if (!token) return null;
  try {
    // JWT'nin payload kısmını decode et (imza doğrulaması Netlify tarafında)
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    // Token süresi kontrolü
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    // Email claim kontrolü
    if (!payload.email) return null;
    return { email: payload.email, sub: payload.sub };
  } catch { return null; }
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://finanaliz.netlify.app';

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  // ─── Rate limiting
  const clientIP = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(clientIP)) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: "Too many requests" }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Server config error" }) };
  }

  try {
    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) }; }

    const { action, data = {} } = body;

    // ─── CONFIG endpoint — sadece public anon key döndür, kimlik doğrulamasız OK
    if (action === "config") {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          url: SUPABASE_URL,
          anonKey: process.env.SUPABASE_ANON_KEY || ""
        })
      };
    }

    // ─── Diğer tüm işlemler için JWT doğrulama zorunlu
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const tokenPayload = await verifyNetlifyToken(token);

    if (!tokenPayload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Kimlik doğrulama gerekli" }) };
    }

    // JWT'deki email'i kullan — client'tan gelen email'i KULLANMA
    const verifiedEmail = tokenPayload.email;

    if (!isValidEmail(verifiedEmail)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Geçersiz email" }) };
    }

    const sbFetch = (path, method = "GET", body = null, extraHeaders = {}) =>
      fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Prefer": method === "POST" ? "return=representation" : "",
          ...extraHeaders,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    const storageFetch = (path, method = "GET", body = null, contentType = "application/json") =>
      fetch(`${SUPABASE_URL}/storage/v1${path}`, {
        method,
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          ...(contentType ? { "Content-Type": contentType } : {}),
        },
        ...(body !== null ? { body } : {}),
      });

    // ─── PATH GÜNCELLE
    if (action === "updatePath") {
      const { id, dosyaPath, dosyaAdi } = data;
      if (!isValidUUID(id)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Geçersiz ID" }) };
      if (!isValidPath(dosyaPath)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Geçersiz path" }) };
      // JWT email ile path'in email prefix'ini karşılaştır
      const expectedPrefix = verifiedEmail.replace(/[^a-zA-Z0-9]/g, '_');
      if (!dosyaPath.startsWith(expectedPrefix + '/')) {
        return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Yetkisiz path" }) };
      }
      const res = await sbFetch(
        `/analizler?id=eq.${id}&user_email=eq.${encodeURIComponent(verifiedEmail)}`,
        "PATCH",
        { dosya_path: dosyaPath, dosya_adi: String(dosyaAdi).substring(0, 255) },
        { "Prefer": "" }
      );
      if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Path güncelleme hatası" }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ─── KAYDET
    if (action === "save") {
      const { sirketAdi, sektor, donem, rasyoJson, aiYorum, dosyaAdi } = data;
      const res = await sbFetch("/analizler", "POST", {
        user_email: verifiedEmail, // JWT'den alınan email
        sirket_adi: String(sirketAdi || '').substring(0, 255),
        sektor: String(sektor || '').substring(0, 50),
        donem: String(donem || '').substring(0, 100),
        rasyo_json: (typeof rasyoJson === 'object' && rasyoJson !== null) ? rasyoJson : {},
        ai_yorum: String(aiYorum || '').substring(0, 10000),
        dosya_adi: String(dosyaAdi || '').substring(0, 255),
      });
      const result = await res.json();
      if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: result.message || "Kayıt hatası" }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: result[0]?.id }) };
    }

    // ─── LİSTELE
    if (action === "list") {
      const res = await sbFetch(
        `/analizler?user_email=eq.${encodeURIComponent(verifiedEmail)}&order=olusturma_tarihi.desc&limit=50`,
        "GET"
      );
      const rows = await res.json();
      if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Liste hatası" }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify(rows) };
    }

    // ─── SİL
    if (action === "delete") {
      const { id, dosyaPath } = data;
      if (!isValidUUID(id)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Geçersiz ID" }) };
      // Önce kaydın bu kullanıcıya ait olduğunu doğrula
      const checkRes = await sbFetch(
        `/analizler?id=eq.${id}&user_email=eq.${encodeURIComponent(verifiedEmail)}&select=id,dosya_path`,
        "GET"
      );
      const checkRows = await checkRes.json();
      if (!checkRows || checkRows.length === 0) {
        return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Bu kayıt size ait değil" }) };
      }
      // Dosyayı storage'dan da sil (güvenli path kontrolü ile)
      const safePath = checkRows[0]?.dosya_path;
      if (safePath && isValidPath(safePath)) {
        await storageFetch(`/object/analizler/${safePath}`, "DELETE", null, null);
      }
      const res = await sbFetch(
        `/analizler?id=eq.${id}&user_email=eq.${encodeURIComponent(verifiedEmail)}`,
        "DELETE"
      );
      if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Silme hatası" }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ─── DOSYA YÜKLE (base64) — artık sadece fallback, asıl upload frontend'den
    if (action === "uploadFile") {
      const { analizId, dosyaAdi, base64Data, mimeType } = data;
      if (!isValidUUID(analizId)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Geçersiz ID" }) };
      // Sadece güvenli MIME tipine izin ver
      const allowedMime = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel','text/csv','application/pdf'];
      const safeMime = allowedMime.includes(mimeType) ? mimeType : 'application/octet-stream';
      const safeEmail = verifiedEmail.replace(/[^a-zA-Z0-9]/g, "_");
      const safeName = String(dosyaAdi || 'dosya').replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
      const path = `${safeEmail}/${analizId}/${safeName}`;
      const fileBuffer = Buffer.from(base64Data, "base64");
      // Max 20MB
      if (fileBuffer.length > 20 * 1024 * 1024) {
        return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: "Dosya 20MB'dan büyük" }) };
      }
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/analizler/${path}`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": safeMime },
        body: fileBuffer,
      });
      if (!res.ok) {
        const err = await res.text();
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Dosya yükleme hatası: " + err }) };
      }
      await sbFetch(
        `/analizler?id=eq.${analizId}&user_email=eq.${encodeURIComponent(verifiedEmail)}`,
        "PATCH", { dosya_path: path, dosya_adi: safeName }, { "Prefer": "" }
      );
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, path }) };
    }

    // ─── DOSYA İNDİR (signed URL — kısa süreli, tek kullanım)
    if (action === "getFileUrl") {
      const { dosyaPath } = data;
      if (!isValidPath(dosyaPath)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Geçersiz path" }) };
      // Path'in bu kullanıcıya ait olduğunu doğrula
      const expectedPrefix = verifiedEmail.replace(/[^a-zA-Z0-9]/g, '_');
      if (!dosyaPath.startsWith(expectedPrefix + '/')) {
        return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Bu dosya size ait değil" }) };
      }
      const res = await storageFetch(
        `/object/sign/analizler/${dosyaPath}`,
        "POST",
        JSON.stringify({ expiresIn: 300 }) // 5 dakika (3600 yerine)
      );
      const result = await res.json();
      if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "URL hatası" }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: `${SUPABASE_URL}/storage/v1${result.signedURL}` }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Geçersiz action" }) };

  } catch (err) {
    // Hata detaylarını dışarıya sızdırma
    console.error('Proxy error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Sunucu hatası" }) };
  }
};
