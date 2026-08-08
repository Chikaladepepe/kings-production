'use strict';
/* ============================================================================
   R2 file adapter — implements the same `files` interface as
   server/disk-files.js:
     put(id, {name,data,mime,size}) / get(id) / del(id)
   Uploads live in a Cloudflare R2 bucket (S3-compatible API) when the R2_*
   env vars are present; otherwise it transparently falls back to the local
   disk adapter (dev / no-storage-config mode).
   ============================================================================ */
const { createDiskFiles } = require('./disk-files.js');

function createR2Files({ bucket, accountId, accessKeyId, secretAccessKey, fallbackDir }) {
  const enabled = !!(bucket && accountId && accessKeyId && secretAccessKey);
  if (!enabled) {
    if (fallbackDir) console.log('[files] R2 not configured — using local disk: ' + fallbackDir);
    return createDiskFiles(fallbackDir);
  }

  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    async put(id, file) {
      const buf = file && file.data !== undefined
        ? (Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data))
        : Buffer.alloc(0);
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: String(id),
        Body: buf,
        ContentType: (file && file.mime) || 'application/octet-stream',
      }));
      return buf.length;
    },
    async get(id) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: String(id) }));
        const bytes = await res.Body.transformToByteArray();
        return { data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
      } catch (e) {
        if (e && (e.name === 'NoSuchKey' || e.name === 'NotFound')) return null;
        console.error('[files] R2 get failed:', e && e.message || e);
        return null;
      }
    },
    async del(id) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: String(id) }));
      } catch (e) {
        console.error('[files] R2 del failed:', e && e.message || e); // never throw (engine fires-and-forgets del)
      }
    },
  };
}

module.exports = { createR2Files };
