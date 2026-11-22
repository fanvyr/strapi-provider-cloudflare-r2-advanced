const { Readable } = require('node:stream');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const factory = require('..');
jest.mock('@aws-sdk/lib-storage', () => ({ Upload: jest.fn() }));

let provider, done, send;
const file = (extra = {}) => ({
  name: 'file.pdf',
  hash: 'original',
  ext: '.pdf',
  mime: 'application/pdf',
  size: 1,
  buffer: Buffer.from('new'),
  ...extra
});
const stored = (key = 'old/tenant/original.pdf') =>
  file({
    provider_metadata: { bucket: 'private', key, isPrivate: true }
  });
const params = () => Upload.mock.calls.at(-1)[0].params;

beforeEach(() => {
  jest.clearAllMocks();
  done = jest.fn().mockResolvedValue({});
  Upload.mockImplementation(() => ({ done }));
  send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({});
  provider = factory.init({
    endpoint: 'https://storage.example.test',
    forcePathStyle: true,
    region: 'auto',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    buckets: { public: 'public-bucket', private: 'private-bucket' },
    publicDomains: { public: 'https://cdn.example.test' },
    rootPath: 'new-root',
    pool: true
  });
});
afterEach(() => jest.restoreAllMocks());

it.each(['replace', 'replaceStream'])(
  '%s overwrites the stored object and leaves formats to Strapi',
  async (method) => {
    const old = stored();
    old.formats = { thumbnail: stored('old/tenant/thumbnail.pdf') };
    const snapshot = JSON.stringify(old);
    const next = file({ path: 'bucket:public:wrong' });
    if (method === 'replaceStream') next.stream = Readable.from(['new']);
    await provider[method](next, old);
    expect(params()).toMatchObject({
      Bucket: 'private-bucket',
      Key: old.provider_metadata.key
    });
    expect(params().Body).toEqual(next.stream || next.buffer);
    expect(next.provider_metadata).toEqual(old.provider_metadata);
    expect(new URL(next.url).pathname).toBe('/private-bucket/old/tenant/original.pdf');
    expect(JSON.stringify(old)).toBe(snapshot);
    expect(send).not.toHaveBeenCalled();
  }
);

it.each([
  ['original.pdf', 'thumbnail_original.pdf'],
  ['old/tenant/original.pdf', 'old/tenant/thumbnail_original.pdf'],
  ['/tenant//name %2F/original.pdf', '/tenant//name %2F/thumbnail_original.pdf']
])('routes new formats beside %s before replacement completes', async (key, variantKey) => {
  const next = file();
  const pending = provider.replaceStream(next, stored(key));
  const thumbnail = file({ hash: 'thumbnail_original', path: next.path });
  await Promise.all([pending, provider.upload(thumbnail)]);
  expect(thumbnail.provider_metadata).toMatchObject({
    bucket: 'private',
    key: variantKey
  });
});

it('preserves the public URL', async () => {
  const old = file({
    provider_metadata: { bucket: 'public', key: 'old/original.pdf' }
  });
  const next = file();
  await provider.replace(next, old);
  expect(next.url).toBe('https://cdn.example.test/old/original.pdf');
});

it.each(['replace', 'replaceStream'])('%s leaves metadata intact when storage rejects the write', async (method) => {
  done.mockRejectedValue(new Error('write failed'));
  const next = file();
  await expect(provider[method](next, stored())).rejects.toThrow('write failed');
  expect(next.provider_metadata).toBeUndefined();
  expect(next.url).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
});

it.each([null, { key: 'file.pdf' }, { bucket: 'missing', key: 'file.pdf' }])(
  'rejects invalid old metadata %j without touching storage',
  async (metadata) => {
    await expect(provider.replace(file(), file({ provider_metadata: metadata }))).rejects.toThrow();
    expect(Upload).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  }
);

it.each([undefined, { CacheControl: 'max-age=60' }])('retains legacy replace(file, %j)', async (customParams) => {
  const next = stored();
  next.formats = { thumbnail: stored('old/thumbnail.pdf') };
  await provider.replace(next, customParams);
  expect(send).toHaveBeenCalledTimes(2);
  expect(params()).toMatchObject({
    Bucket: 'private-bucket',
    Key: 'new-root/original.pdf',
    ...customParams
  });
  expect(next.path).toBe('bucket:private:old/tenant');
});

it('retains ordinary upload, signing and delete behavior used by older Strapi', async () => {
  const next = file({ path: 'bucket:private:tenant' });
  await provider.uploadStream(next);
  expect(next.provider_metadata.key).toBe('new-root/original.pdf');
  expect(await provider.getSignedUrl(next)).toContain('X-Amz-Signature=');
  await provider.delete(next);
  expect(send.mock.calls[0][0].input).toMatchObject({
    Bucket: 'private-bucket',
    Key: 'new-root/original.pdf'
  });
});
