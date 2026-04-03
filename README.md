# MGKomik Mirror Proxy

Full reverse proxy mirror untuk `id.mgkomik.cc` yang dioptimasi untuk SEO. Bisa di-deploy ke **Railway**, **Render**, atau **VPS pribadi**.

## Fitur SEO

- **Canonical tag** — Semua `<link rel="canonical">` ditulis ulang ke domain mirror
- **Structured Data (JSON-LD)** — URL di JSON-LD ditulis ulang, BreadcrumbList divalidasi
- **Sitemap & robots.txt** — URL di sitemap dan robots.txt ditulis ulang
- **OG:URL** — Meta Open Graph di-fix ke domain mirror
- **Redirect handling** — Header `Location` ditulis ulang supaya tidak mengarah ke domain asli
- **Full URL rewriting** — Semua referensi ke domain asli (href, src, srcset, inline script/style) ditulis ulang
- **Status code forwarding** — Status code dari upstream diteruskan apa adanya (tidak jadi 404 palsu)

## Konfigurasi

Set environment variables:

| Variable | Wajib | Default | Keterangan |
|----------|-------|---------|------------|
| `SOURCE_HOST` | Tidak | `id.mgkomik.cc` | Domain sumber yang di-mirror |
| `MIRROR_HOST` | **Ya (produksi)** | auto-detect | Domain mirror kamu, contoh: `mgkomik.com` |
| `PORT` | Tidak | `3000` | Port server (Railway/Render set otomatis) |

## Deploy ke Railway

1. Push repo ini ke GitHub
2. Buka [railway.app](https://railway.app), buat project baru dari GitHub repo
3. Set environment variables:
   ```
   MIRROR_HOST=domainmu.com
   SOURCE_HOST=id.mgkomik.cc
   ```
4. Railway akan otomatis build dan deploy

## Deploy ke Render

1. Push repo ini ke GitHub
2. Buka [render.com](https://render.com), buat **Web Service** baru
3. Connect ke repo GitHub
4. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Set environment variables di dashboard Render

## Deploy ke VPS

```bash
# Clone repo
git clone https://github.com/username/mgkomik.git
cd mgkomik

# Install dependencies
npm install

# Set environment variables
export SOURCE_HOST=id.mgkomik.cc
export MIRROR_HOST=domainmu.com
export PORT=3000

# Jalankan
node server.js

# Atau pakai Docker
docker build -t mgkomik-mirror .
docker run -d -p 3000:3000 \
  -e SOURCE_HOST=id.mgkomik.cc \
  -e MIRROR_HOST=domainmu.com \
  mgkomik-mirror
```

### Dengan PM2 (direkomendasikan untuk VPS)

```bash
npm install -g pm2
pm2 start server.js --name mgkomik-mirror
pm2 save
pm2 startup
```

### Nginx Reverse Proxy (opsional)

```nginx
server {
    listen 80;
    server_name domainmu.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Catatan Penting

### Cloudflare Challenge
Jika `id.mgkomik.cc` dilindungi Cloudflare (bot challenge / "Just a moment..."), kamu perlu:
1. **Whitelist IP server** di Cloudflare (Firewall Rules → Allow IP)
2. Atau gunakan **direct origin URL** (bukan yang di-proxy Cloudflare) sebagai `SOURCE_HOST`
3. Atau matikan **Bot Fight Mode** di Cloudflare untuk akses dari IP server

### Google Search Console
Setelah deploy:
1. Verifikasi domain mirror di Google Search Console
2. Submit sitemap: `https://domainmu.com/sitemap.xml`
3. Gunakan **URL Inspection** untuk cek halaman
4. Pastikan tidak ada `id.mgkomik.cc` yang bocor di halaman (cek view-source)