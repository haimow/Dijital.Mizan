// functions/supabase-proxy.mjs
// Netlify Function — Supabase CRUD + Storage proxy
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Supabase env vars not set." }) };
  }

  try {
    const { action, userEmail, data } = JSON.parse(event.body);

    if (!userEmail) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "userEmail required" }) };

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

    // KAYDET
    if (action === "save") {
      const { sirketAdi, sektor, donem, rasyoJson, aiYorum, dosyaAdi } = data;
      const res = await sbFetch("/analizler", "POST", {
        user_email: userEmail,
        sirket_adi: sirketAdi || "",
        sektor: sektor || "",
        donem: donem || "",
        rasyo_json: rasyoJson || {},
        ai_yorum: aiYorum || "",
        dosya_adi: dosyaAdi || "",
      });
      const result = await res.json();
      if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: result.message || "Kayıt hatası" }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: result[0]?.id }) };
    }

    // LİSTELE
    if (action === "list") {
      const res = await sbFetch(
        `/analizler?user_email=eq.${encodeURIComponent(userEmail)}&order=olusturma_tarihi.desc&limit=50`,
        "GET"
      );
      const rows = await res.json();
      if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Liste hatası" }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify(rows) };
    }

    // SİL
    if (action === "delete") {
      const { id, dosyaPath } = data;
      // Dosyayı storage'dan da sil
      if (dosyaPath) {
        await storageFetch(`/object/analizler/${dosyaPath}`, "DELETE", null, null);
      }
      const res = await sbFetch(
        `/analizler?id=eq.${id}&user_email=eq.${encodeURIComponent(userEmail)}`,
        "DELETE"
      );
      if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Silme hatası" }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // DOSYA YÜKLE (base64)
    if (action === "uploadFile") {
      const { analizId, dosyaAdi, base64Data, mimeType } = data;
      const safeEmail = userEmail.replace(/[^a-zA-Z0-9]/g, "_");
      const path = `${safeEmail}/${analizId}/${dosyaAdi}`;
      const fileBuffer = Buffer.from(base64Data, "base64");

      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/analizler/${path}`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": mimeType || "application/octet-stream",
        },
        body: fileBuffer,
      });

      if (!res.ok) {
        const err = await res.text();
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Dosya yükleme hatası: " + err }) };
      }

      // Analiz kaydına dosya path'ini ekle
      await sbFetch(
        `/analizler?id=eq.${analizId}&user_email=eq.${encodeURIComponent(userEmail)}`,
        "PATCH",
        { dosya_path: path, dosya_adi: dosyaAdi },
        { "Prefer": "" }
      );

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, path }) };
    }

    // DOSYA İNDİR (signed URL)
    if (action === "getFileUrl") {
      const { dosyaPath } = data;
      const res = await storageFetch(
        `/object/sign/analizler/${dosyaPath}`,
        "POST",
        JSON.stringify({ expiresIn: 3600 })
      );
      const result = await res.json();
      if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "URL hatası" }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: `${SUPABASE_URL}/storage/v1${result.signedURL}` }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Geçersiz action" }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Proxy: " + err.message }) };
  }
};
