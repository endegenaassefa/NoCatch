'use strict';

function validateImage(image) {
  const invalid = () => Object.assign(new Error('Use a valid PNG, JPEG or WebP image smaller than 2 MiB.'), { code: 'INPUT_LIMIT' });
  if (!image || !['image/png','image/jpeg','image/webp'].includes(image.mimeType) || typeof image.data !== 'string' || image.data.length > 2800000 ||
      image.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw invalid();
  const bytes = Buffer.from(image.data, 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw invalid();
  const valid = image.mimeType === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (!valid) throw invalid();
  return image;
}
module.exports = { validateImage };
