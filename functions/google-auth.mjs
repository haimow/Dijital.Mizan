// Netlify Function — Google OAuth redirect interceptor
// GoTrue /authorize'dan Google OAuth URL'sini yakalar,
// prompt=select_account ekler → kullanıcı hesap seçim ekranını görür.

export default async function handler(req, context) {
  const siteUrl = process.env.URL || 'https://mizanmind.netlify.app';
  const gotrueUrl = `${siteUrl}/.netlify/identity/authorize?provider=google`;

  try {
    // GoTrue'dan redirect URL'sini al ama takip etme
    const res = await fetch(gotrueUrl, { redirect: 'manual' });
    const location = res.headers.get('location');

    if (location && location.includes('accounts.google.com')) {
      // Google OAuth URL'ye prompt=select_account ekle
      const googleUrl = new URL(location);
      googleUrl.searchParams.set('prompt', 'select_account');

      return new Response(null, {
        status: 302,
        headers: {
          'Location': googleUrl.toString(),
          'Cache-Control': 'no-store, no-cache'
        }
      });
    }

    // GoTrue zaten doğru URL döndürdüyse (fallback)
    return new Response(null, {
      status: 302,
      headers: {
        'Location': location || `${gotrueUrl}&prompt=select_account`
      }
    });
  } catch {
    // Hata durumunda standart GoTrue akışına dön
    return new Response(null, {
      status: 302,
      headers: { 'Location': `${gotrueUrl}&prompt=select_account` }
    });
  }
}
