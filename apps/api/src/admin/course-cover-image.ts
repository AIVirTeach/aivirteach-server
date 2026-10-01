export const MAX_COVER_IMAGE_BYTES = 10 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_SIGNATURES = ['GIF87a', 'GIF89a'];

// 只信 magic bytes，不信调用方传来的文件名后缀——防止把改了后缀名的非图片文件当封面传上去。
export function detectImageExtension(buffer: Buffer): string | null {
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return '.png';
  }
  if (buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return '.jpg';
  }
  if (GIF_SIGNATURES.includes(buffer.subarray(0, 6).toString('ascii'))) {
    return '.gif';
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp';
  }
  return null;
}
