# strapi-provider-cloudflare-r2-advanced  
### Advanced Cloudflare R2 provider for Strapi v5  
✨ Multi-bucket support · 🔐 Private signed URLs · 🚀 AWS SDK v3 · 🪶 TypeScript

---

## 🚀 Overview

`strapi-provider-cloudflare-r2-advanced` is a **production-ready upload provider** for **Strapi v5**, designed to integrate seamlessly with **Cloudflare R2** (S3-compatible object storage).

It offers advanced capabilities beyond standard S3 providers:

- **Multi-bucket support** (public, private, custom separation)
- **Automatic signed URLs** for private buckets  
- **Secure private/public domain routing**
- **True Cloudflare R2 compatibility**  
- **Advanced image format deletion** (thumbnail, small, medium, large)  
- **Streaming uploads using AWS SDK v3**
- **Clean TypeScript implementation**
- **Non-breaking replacement of existing S3 or R2 providers**

Its not fully battle tested but is working right now, please open issues if you find some. 

---
This provider was initially inspired by the [community strapi-provider-cloudflare-r2](https://market.strapi.io/providers/strapi-provider-cloudflare-r2), but has been significantly extended and rewritten for advanced multi-bucket support, private/public logic, and seamless compatibility with Strapi v5 and AWS SDK v3.

Mainly because i needed multiple buckets. 

> ⚠️ **Warning:**  
> This provider currently supports **only a single set of S3 (Cloudflare R2) credentials**.  
> You cannot configure different API keys or accounts per bucket; all buckets must live under the same Cloudflare R2 account and credentials.  
>  
> _If you require true per-bucket credential isolation, open an issue to discuss the use-case!_


---

## 📦 Installation

```bash
npm install strapi-provider-cloudflare-r2-advanced
# or
yarn add strapi-provider-cloudflare-r2-advanced
```

---

## ⚙️ Configuration (Strapi v5)

Create or modify:

```
/config/plugins.ts
```

### Example configuration with multi-bucket setup

```ts
export default () => ({
  upload: {
    config: {
      provider: "strapi-provider-cloudflare-r2-advanced",
      providerOptions: {
        endpoint: env("CF_ENDPOINT"), // Example: "https://<accountid>.r2.cloudflarestorage.com"

        // Optional internal prefix for all stored R2 object keys
        // If rootPath = "v1/uploads", your files will be stored like:
        //   v1/uploads/company/123/file.jpg
        rootPath: null,

        // Optional override for the returned PUBLIC URLs (applies only to buckets listed in publicDomains)
        // If baseUrl = "https://cdn.example.com/assets", final URLs become:
        //   https://cdn.example.com/assets/company/123/file.jpg
        baseUrl: null,

        /**
         * Cloudflare R2 Credentials
         * Obtain these at:
         * https://dash.cloudflare.com/[your-account-id]/r2/api-tokens
         */
        accessKeyId: env("R2_ACCESS_KEY_ID"),
        secretAccessKey: env("R2_SECRET_ACCESS_KEY"),

        /**
         * Bucket routing by *logical* name.
         *
         * IMPORTANT:
         * These names are NOT special — "public" / "private" are NOT reserved.
         * You can choose ANY bucket name, e.g. "uploads", "invoices", "tenantAssets".
         *
         * The *privacy* of a bucket depends ONLY on whether it has a corresponding entry
         * inside `publicDomains`.
         */
        buckets: {
          uploads: env("CF_BUCKETS_UPLOADS"),                 // logicalName: actualBucketName
          internalAssets: env("CF_BUCKETS_INTERNAL_ASSETS")
        },

        /**
         * Public CDN domains
         *
         * A bucket becomes PUBLIC if (and only if) it appears in this object.
         * If a bucket key does NOT exist here -> it becomes PRIVATE and uses SIGNED URLs.
         *
         * TIP:
         * Use environment variables prefixed with CF_PUBLIC_ACCESS_URL_*
         * (Important to correctly generate security middleware)
         */
        publicDomains: {
          uploads: env("CF_PUBLIC_ACCESS_URL_UPLOADS")        // Only 'uploads' bucket is public
        },

        // Default bucket if none is matched via prefix or file path
        defaultBucket: "uploads",

        // Signed URL TTL (applies only to private buckets)
        signedUrlExpires: 3600
      }
    }
  }
});
```

### Frontend Upload Example (Vanilla `/api/upload`)

A minimal example of uploading from your frontend (Nuxt/Vue, React, plain JS, etc.):

```ts
// Example: Nuxt/Vue Composition API
const file = ref<File | null>(null);

async function upload() {
  const formData = new FormData();

  // The important part: include your desired path
  // This determines bucket + folder routing:
  // Example: bucket:public:company/123/logos
  formData.append("path", "bucket:public:company/123/logos");

  // The actual file (or multiple)
  formData.append("files", file.value as File);

  const res = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  });

  const uploaded = await res.json();
  console.log("Uploaded:", uploaded);
}
```

This works because Strapi’s Upload plugin internally reads `path` and `files` from the multipart payload, and the provider determines:

- which bucket to use  
- file destination path  
- whether signed or public URLs should be generated  

### Middleware Configuration (CSP for Public Domains)

When using public CDN domains for Cloudflare R2, make sure Strapi's Content-Security-Policy (CSP) allows images and media from those domains.

Add this to your `config/middlewares.ts`:

```ts
export default ({ env }) => {
  const prefix = 'CF_PUBLIC_ACCESS_URL_';

  // Extract domain hostnames from env vars:
  const domains = Object.keys(process.env)
    .filter(key => key.startsWith(prefix))
    .map(key => process.env[key])
    .filter(Boolean)
    .map((domain: string) => domain.replace(/^https?:\/\//, ""));

  return [
    'strapi::logger',
    'strapi::errors',
    {
      name: "strapi::security",
      config: {
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            "connect-src": ["'self'", "https:"],
            "img-src": [
              "'self'",
              "data:",
              "blob:",
              "market-assets.strapi.io",
              ...domains
            ],
            "media-src": [
              "'self'",
              "data:",
              "blob:",
              "market-assets.strapi.io",
              ...domains
            ],
            upgradeInsecureRequests: null,
          },
        },
      },
    },
    // ... rest of middleware stack
  ];
};
```

This ensures the Media Library UI and frontend can display files hosted on any public R2 bucket domain listed under your `CF_PUBLIC_ACCESS_URL_*` environment variables. (Images/Files from private buckets will not have a preview in the Media Library)

---

## 🔌 Upload Behavior

### ✔ Multi-bucket routing

Bucket selection is based on:

1. `bucket:` prefix found in file.path  
2. `providerOptions.buckets`  
3. `defaultBucket`

Example path:

```
bucket:private:company/123/invoices
```

This file will always use the `private` bucket.

---

### ✔ Public vs. Private URL generation

**Public bucket example:**

```
https://cdn.example.com/company/123/file.jpg
```

**Private bucket example:**

Uses **signed URLs** generated via AWS SDK v3:

```
https://<r2-endpoint>/company/.../file.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256 ...
```

---

## 🔐 Signed URLs (Private)

You can manually request a signed URL using:

```ts
const url = await strapi
  .plugin("upload")
  .provider.getSignedUrl(file);
```

Private files **always** return signed URLs.  
Public files **never** return signed URLs.

---

## 🗑️ Full File Deletion (Including Formats)

Strapi often generates image formats:

- `thumbnail`
- `small`
- `medium`
- `large`

This provider **deletes all formats**, not just the main file.

Use Strapi’s own service:

```ts
await strapi
  .plugin("upload")
  .service("upload")
  .remove(file);
```

This:

- Deletes the main R2 object  
- Deletes all resized formats  
- Removes DB entry  
- Unlinks from related entities  
- Cleans Media Library automatically  

**You should NOT call provider.delete() directly.**

---

## 📘 How Provider Metadata is Stored

On each file Strapi stores:

```json
{
  "bucket": "private",
  "key": "company/abc123/file.jpg",
  "isPrivate": true
}
```

Formats include their own metadata as well.

---

## 🧪 Testing

Install dependencies:

```bash
npm install
npm test
```

(Tests are scaffold-ready; add more for your use-case.)

---

## 🏗 Project Structure

```
strapi-provider-cloudflare-r2-advanced/
├── src/
│   └── index.ts        # Provider implementation
├── dist/               # Compiled output
├── tests/              # Basic test suite
├── package.json
├── tsconfig.json
└── README.md
```

---

## 💡 Features Summary

| Feature | Status |
|--------|--------|
| Strapi v5 compatible | ✅ |
| AWS SDK v3 | ✅ |
| Cloudflare R2 region:auto | ✅ |
| Multi-bucket support | ✅ |
| Private/public logic | ✅ |
| Signed URLs | ✅ |
| Streaming upload | ✅ |
| Delete all formats | ✅ |
| Typescript | ✅ |

---

## 🔐 Security & Stability

This package:

- Never exposes S3 credentials  
- Does not trust user-supplied bucket names  
- Sanitizes input paths  
- Ensures private file access is signed-only  
- Ensures deterministic bucket selection  

This makes it safe for multi-tenant SaaS projects.

### ⚠️ Known Limitation: Replace Operation Inside Strapi Media Library

Strapi’s Admin Panel currently does **not** pass the original object path to the provider when replacing a file via the **Media Library → Replace** action.

As a result:

- The replaced file is correctly uploaded to R2
- It uses the correct bucket
- **BUT it is always placed at the root of the bucket**
- Image formats (`thumbnail`, `small`, etc.) also get placed at root
- Folder structure inside the Media Library remains unchanged

This is a **Strapi core limitation** — the Upload plugin does *not* provide the original file’s `path` or `folderPath` to the provider on replace.  
No upload provider (AWS S3, DigitalOcean Spaces, or community R2 providers) can fix this on their own.

If you need stable per-entity folder structures, prefer **deleting and re-uploading** files until Strapi exposes proper replace-path hooks.

A GitHub issue will be linked here once opened.

---

## 📜 License

MIT — free for commercial and open-source usage.

---

## 🙌 Contributing

PRs, issues, and suggestions are welcome.  
Feel free to open discussions for feature improvements.
