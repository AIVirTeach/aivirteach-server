import {
  detectImageExtension,
  MAX_COVER_IMAGE_BYTES,
} from './course-cover-image';

describe('detectImageExtension', () => {
  it('识别 PNG 签名', () => {
    const buffer = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('rest-of-file'),
    ]);
    expect(detectImageExtension(buffer)).toBe('.png');
  });

  it('识别 JPEG 签名', () => {
    const buffer = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from('rest-of-file'),
    ]);
    expect(detectImageExtension(buffer)).toBe('.jpg');
  });

  it('识别 GIF 签名', () => {
    const buffer = Buffer.concat([
      Buffer.from('GIF89a'),
      Buffer.from('rest-of-file'),
    ]);
    expect(detectImageExtension(buffer)).toBe('.gif');
  });

  it('识别 WEBP 签名', () => {
    const buffer = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP'),
      Buffer.from('rest-of-file'),
    ]);
    expect(detectImageExtension(buffer)).toBe('.webp');
  });

  it('纯文本文件返回 null（不是任何已知图片格式）', () => {
    expect(
      detectImageExtension(Buffer.from('hello world, this is not an image')),
    ).toBeNull();
  });

  it('空 buffer 返回 null', () => {
    expect(detectImageExtension(Buffer.alloc(0))).toBeNull();
  });
});

describe('MAX_COVER_IMAGE_BYTES', () => {
  it('上限是 10MB', () => {
    expect(MAX_COVER_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});
