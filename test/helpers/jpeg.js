// A small plain JPEG, written by jpeg-js (test/image.test.js).
import jpeg from 'jpeg-js';

export function smallJpeg(width = 64, height = 36, shade = 120) {
  const data = Buffer.alloc(width * height * 4, shade);
  return Buffer.from(jpeg.encode({ width, height, data }, 80).data);
}
