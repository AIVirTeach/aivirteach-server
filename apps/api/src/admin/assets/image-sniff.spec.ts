import { sniffImageMime } from './image-sniff';

describe('sniffImageMime', () => {
  it.each([
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    [Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg'],
    [Buffer.from('GIF87a'), 'image/gif'],
    [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.from('RIFFxxxxWEBP'), 'image/webp'],
  ])('recognizes %s', (buffer, mime) => {
    expect(sniffImageMime(buffer as Buffer)).toBe(mime);
  });

  it.each([
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from('<html>not an image</html>'),
    Buffer.from('%PDF-1.7'),
    Buffer.alloc(0),
    Buffer.from([0x89, 0x50, 0x4e]),
  ])('rejects non-image or short content', (buffer) => {
    expect(sniffImageMime(buffer)).toBeNull();
  });

  it('uses bytes rather than a filename extension', () => {
    const pngNamedJpg = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffImageMime(pngNamedJpg)).toBe('image/png');
  });
});
