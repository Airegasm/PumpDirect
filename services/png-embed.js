/**
 * PNG tEXt Chunk Embedding Service
 *
 * Creates and embeds tEXt chunks into PNG files for character card metadata.
 * Used by both V3 (chara/ccv3 keys) and SwellD (swelld key) export formats.
 *
 * PNG chunk structure:
 *   [4B length][4B type][data][4B CRC]
 * tEXt chunk data:
 *   [keyword\0value]
 */

const zlib = require('zlib');

/**
 * Create a PNG tEXt chunk with the given key and base64-encoded JSON value
 * @param {string} key - Chunk keyword (e.g., 'chara', 'ccv3', 'swelld')
 * @param {string} jsonString - JSON string to base64-encode and embed
 * @returns {Buffer} Complete tEXt chunk including length, type, data, and CRC
 */
function createTEXtChunk(key, jsonString) {
  const base64Value = Buffer.from(jsonString, 'utf-8').toString('base64');

  // Build chunk data: key + null separator + base64 value
  const keyBuffer = Buffer.from(key, 'latin1');
  const nullByte = Buffer.from([0]);
  const valueBuffer = Buffer.from(base64Value, 'latin1');
  const chunkData = Buffer.concat([keyBuffer, nullByte, valueBuffer]);

  // Chunk type
  const typeBuffer = Buffer.from('tEXt', 'ascii');

  // Calculate CRC over type + data
  const crcInput = Buffer.concat([typeBuffer, chunkData]);
  const crc = zlib.crc32(crcInput);

  // Build complete chunk: [4B length][4B type][data][4B CRC]
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(chunkData.length, 0);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([lengthBuffer, typeBuffer, chunkData, crcBuffer]);
}

/**
 * Embed one or more tEXt chunks into a PNG buffer (before IEND)
 * @param {Buffer} pngBuffer - Original PNG file buffer
 * @param {Array<{key: string, json: string}>} chunks - Array of {key, json} to embed
 * @returns {Buffer} New PNG buffer with embedded chunks
 */
function embedChunksInPNG(pngBuffer, chunks) {
  // Find IEND chunk offset
  // IEND is always the last chunk: [4B length=0][IEND][4B CRC]
  // Search backwards for 'IEND' marker
  const iendMarker = Buffer.from('IEND', 'ascii');
  let iendOffset = -1;

  for (let i = pngBuffer.length - 8; i >= 8; i--) {
    if (pngBuffer[i] === 0x49 && // I
        pngBuffer[i + 1] === 0x45 && // E
        pngBuffer[i + 2] === 0x4E && // N
        pngBuffer[i + 3] === 0x44) { // D
      // The chunk starts 4 bytes before the type (at the length field)
      iendOffset = i - 4;
      break;
    }
  }

  if (iendOffset === -1) {
    throw new Error('Invalid PNG: IEND chunk not found');
  }

  // Split the PNG at the IEND offset
  const beforeIEND = pngBuffer.slice(0, iendOffset);
  const iendAndAfter = pngBuffer.slice(iendOffset);

  // Build all tEXt chunks
  const textChunks = chunks.map(({ key, json }) => createTEXtChunk(key, json));

  // Concatenate: [before IEND][tEXt chunks][IEND]
  return Buffer.concat([beforeIEND, ...textChunks, iendAndAfter]);
}

module.exports = {
  createTEXtChunk,
  embedChunksInPNG
};
